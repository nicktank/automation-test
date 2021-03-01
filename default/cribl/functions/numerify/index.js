exports.disabled = 0;
exports.name = 'Numerify';
exports.version = '0.3';
exports.group = 'Standard';

let conf = {};
let WLIgnoreList = null;
let formatter;
exports.init = (opt) => {
  conf = (opt || {}).conf || {};
  WLIgnoreList = null;
  conf.ignoreFields = (conf.ignoreFields || []).map(k => k.trim()).filter(k => k.length);
  if (conf.ignoreFields.length > 0) {
    WLIgnoreList = new C.util.WildcardList(conf.ignoreFields);
  }

  conf.digits = Number(conf.digits); 
  const digits = Number.isNaN(conf.digits) ? 2 : conf.digits;

  switch (conf.format) {
    case 'fix': formatter = (n) => Number(n.toFixed(digits)); break;
    case 'floor': formatter = (n) => Math.floor(n); break;
    case 'ceil': formatter = (n) => Math.ceil(n); break;
    default: formatter = (n) => n;
  }
};

exports.process = (event) => {
  if (!event) return event;

  event.__traverseAndUpdate(5, (path, val) => {
    const asNum = Number(val);
    if (Number.isNaN(asNum) || (WLIgnoreList && WLIgnoreList.test(path))) {
      return val;
    }
    return formatter(asNum);
  });
  return event;
};

