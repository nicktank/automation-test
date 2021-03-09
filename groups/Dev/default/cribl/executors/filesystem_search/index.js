/* eslint-disable no-continue */
/* eslint-disable consistent-return */
/* eslint-disable no-unused-expressions */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-loop-func */
/* eslint-disable no-await-in-loop */
exports.jobType = 'task-per-node';
exports.waitForResults = true;
exports.name = 'Filesystem search';
exports.version = '0.1';
exports.disabled = false;

const os = require('os');
const _path = require('path')

const {
  Generators: { fromFile, MergeSortGenerator, pipe },
  Path: { pathFilter },
  scopedResource,
} = C.internal;
const {
  expr: { Expression },
} = C;
let pathProvider;
let filter;
let contentFilter;
let recurse;
let dir;
let batchSize;
let maxResults;
let resultsCount = 0;
let reverseResults;
let compareExpression;
let sortResults;
let sortCursor;

class FifoQueue {
  constructor(_id) {
    this.id = _id;
    this.state = {};
    this.tail = 0;
    this.head = 0;
    this._done = false;
  }
  push(el) {
    this.state[this.tail++] = el;
  }
  next() {
    if (this.size() <= 0) return undefined;
    const next = this.state[this.head];
    delete this.state[this.head];
    this.head++;
    if (this.head === this.tail) {
      this.head = 0;
      this.tail = 0;
    }
    return next;
  }
  peek() {
    return this.state[this.head];
  }
  destroy() {
    this.state = undefined;
    this.head = 0;
    this.tail = 0;
    this._done = true;
  }
  done() {
    this._done = true;
  }
  isDone() {
    return this._done && this.size() === 0;
  }
  isEmpty() {
    return !this._done && this.size() === 0;
  }
  size() {
    return this.tail - this.head;
  }
}
class MergeSortCursor {
  constructor(compare, _sort) {
    this._compare = compare;
    this.map = new Map();
    this.sort = _sort;
  }
  getQueue(id, logger) {
    let q = this.map.get(id);
    if (!q) {
      logger.debug('added queue', { taskId: id });
      q = new FifoQueue(id);
      this.map.set(id, q);
    }
    return q;
  }
  putAt(id, result, logger) {
    const q = this.getQueue(id, logger);
    if (!result) return;
    if (result.done) {
      logger.debug('queue done', { taskId: id });
      return q.done();
    }
    q.push(result);
  }
  remove(id) {
    this.map.delete(id);
  }
  getQueues() {
    return Array.from(this.map.values());
  }
  getNext() {
    if (this.getQueues().some((e) => e.isEmpty())) return;
    if (!sortResults) {
      return this.getUnsortedNext();
    }
    const _queue = this.getQueues()
      .filter((q) => !q.isDone())
      .sort((e, e1) => this._compare.evalOn({ evtA: e.peek(), evtB: e1.peek() }))[0];

    if (this.getQueues().some((e) => e.isEmpty())) return;

    return _queue && _queue.next();
  }

  getUnsortedNext() {
    for (const queue of this.map.values()) {
      if (!queue.isDone()) {
        return queue.next();
      }
    }
    return undefined;
  }

  allDone() {
    return !this.getQueues().some((e) => !e.isDone());
  }
  getMap() {
    return this.map;
  }
  destroy() {
    this.getQueues().forEach((e) => e.destroy());
    this.map = new Map();
  }
}

/*
  create a collection task per worker for a filtered path /a/path/to/afile/
  write contents as results
*/
function isDefined(value) {
  return typeof value !== 'undefined';
}
exports.initJob = async (opts) => {
  const { conf } = opts.conf.executor;
  compareExpression = conf.compareExpression && new Expression(conf.compareExpression, { disallowAssign: true });
  reverseResults = conf.reverseResults != null ? conf.reverseResults : false;
  maxResults = conf.maxResults || 1000;
  sortResults = isDefined(compareExpression);
  resultsCount = 0;
  sortCursor = new MergeSortCursor(compareExpression, sortResults);
};

exports.jobOnAddedTask = async (job, taskId) => {
  job.logger().debug('added task', { taskId });
  sortCursor.putAt(taskId, undefined, job.logger());
};
exports.jobOnTaskCompleted = async (job, taskId) => {
  job.logger().info('completed task', { taskId });
  sortCursor.putAt(taskId, { done: true }, job.logger());
};
exports.jobOnResult = async (job, result) => {
  sortCursor.putAt(result.taskId, result, job.logger());
  let res = sortCursor.getNext();
  while (res && resultsCount < maxResults) {
    resultsCount++; // increment counter before yielding control to prevent pushing over the count.
    try {
      await job.addResult({ content: res._raw, size: res._raw.length, file: res.file, taskId: res.taskId });
    } catch (e) {
      resultsCount--;
      throw e;
    }
    res = sortCursor.getNext();
  }
  if (sortCursor.allDone() || resultsCount >= maxResults) {
    sortCursor.destroy();
    await job.finishJob();
  }
};

exports.initTask = async (opts) => {
  const conf = opts.conf;
  const path = conf.path;
  dir = path && path.startsWith('~/') ? path.replace('~', os.homedir()) : path;
  if (dir == null) return Promise.reject(new Error('path is required'));
  dir = C.util.resolveEnvVars(dir);
  dir = _path.resolve(dir);
  recurse = conf.recurse != null ? conf.recurse : true;
  reverseResults = conf.reverseResults != null ? conf.reverseResults : false;
  filter = conf.filter || 'true';
  compareExpression = conf.compareExpression && new Expression(conf.compareExpression, { disallowAssign: true });
  contentFilter = conf.contentFilter;
  batchSize = conf.resultBatchSize || 10;
  maxResults = conf.maxResults || 1000;
  resultsCount = 0;
  sortResults = isDefined(compareExpression);
};
exports.jobSeedTask = async () => {
  return {
    dir,
    filter,
  };
}; // the first task pushed to the queue

exports.jobOnError = async () => {};
let files;

exports.taskExecute = async (job) => {
  files = [];
  const paths = [];
  job.logger().debug('Directory', { dir });
  try {
    pathProvider = C.internal.Path.fileSystemProvider(recurse, dir);
    await pathProvider.init();
    const _pathFilter = pathFilter(dir, filter, pathProvider, job.logger());
    let curPath = await _pathFilter.getNextPath();

    while (!curPath.done) {
      const filePath = curPath.val;
      paths.push(filePath);
      curPath = await _pathFilter.getNextPath();
    }
  } catch (e) {
    await job.addResult({ done: true });
    await job.reportError(e);
  }
  job.logger().debug('Files', { paths });
  files = (
    await Promise.all(
      paths.map(async (filePath) => {
        let file;
        try {
          file = await fromFile(filePath, undefined, reverseResults);
          // reverse read is only bylines
          file = reverseResults ? file.jsonParse(true) : file.byLines(true, true);
        } catch (error) {
          // don't crash if somebody pulls the rug from under us
          job.reportError(error).catch(() => {});
        }
        return (
          !!file &&
          file
            .map((obj) => {
              obj.time && (obj._time = new Date(obj.time).getTime());
              obj.file = filePath;
              return obj;
            })
            .filteredBy(contentFilter)
            .execute()
        );
      })
    )
  ).filter((e) => !!e);

  if (files.length > 1000) {
    job.logger().warn('Warning more than 1000 files opened on this task', { filesCount: files.length });
  }

  if (files.length) {
    await scopedResource(
      pipe(new MergeSortGenerator((evtA, evtB) => compareExpression.evalOn({ evtA, evtB }), files, sortResults))
        .byChunksOf(batchSize)
        .execute(),
      async (mergeStream) => {
        let { value, done } = await mergeStream.next();

        while (!done && (!maxResults || resultsCount <= maxResults)) {
          const remaining = maxResults - resultsCount;
          const results = maxResults && value.length > remaining ? value.slice(0, remaining) : value;
          await job.addResults(results);
          resultsCount += results.length;
          ({ value, done } = await mergeStream.next());
        }
        await job.addResult({ done: true }); // we need both task finished hook and this, in case task fails on init or all results get pushed before the limit is reached.
      }
    );

    try {
      await Promise.all(files.map(async (f) => f.destroy()));
    } catch (e) {
      // ignore
    }
  } else {
    await job.addResult({ done: true });
  }
};

exports.taskOnCancel = async () => {
  try {
    files && files.length && (await Promise.all(files.map(async (f) => f.destroy())));
  } catch (e) {
    //  ignore
  }
};
