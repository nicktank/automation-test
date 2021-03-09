exports.name = 'Flatten';
exports.version = '0.1';
exports.disabled = false;
exports.group = 'Formatters';

const DEFAULT_DEPTH = 5;

let prefix = "";
let depth = DEFAULT_DEPTH;
let delimiter = "_";
let wildCardList = undefined;

exports.init = (opts) => {
  const conf = opts.conf;
  wildCardList = new C.util.WildcardList(
    (conf.fields === undefined || conf.fields.length === 0) ? ['*'] : conf.fields);
  prefix = conf.prefix;
  depth = conf.depth >= 1 ? conf.depth : DEFAULT_DEPTH;
  delimiter = conf.delimiter;
};

exports.process = (event) => {
  event.__traverseForFlatten(event, depth, (path, value, obj, key, level) => {
    if (level === depth && event.__isInternalField(key)) { return true; }
    if (level === depth && !wildCardList.test(key)) { return true; }
    // for now, we are dealing with matched objects
    if (level === 1 && (typeof value === "object")) {
      value = JSON.stringify(value);
    }
    if (level === depth) { // if its an higher level object delete it
      delete event[key];
    }
    if (typeof value !== "object") { // if its a literal update event
      event[path] = value;
    }
    return (typeof value !== "object");
  }, prefix, delimiter);
  return event;
};
