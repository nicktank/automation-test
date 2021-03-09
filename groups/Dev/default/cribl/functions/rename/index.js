exports.name = 'Rename';
exports.version = '0.1';
exports.disabled = false;
exports.group = 'Standard';

const { Expression, NestedPropertyAccessor } = C.expr;
const cLogger = C.util.getLogger('func:rename');

let fields2rename = []; //NestedPropertyAccessor[]: currentName1, newName1, currentName2, newName2 ... 
let renameExpr;
let baseFields = [];

function getAccessor(fieldName) {
    return new NestedPropertyAccessor(fieldName);
}

function rename(currentField, newField, context) {
  if (typeof currentField !== 'object' || typeof newField !== 'object') return;
  const val = currentField.get(context);
  if (!val) return;
  // rename is just about creating a new field with the new name
  newField.set(context, currentField.get(context));
  // for performance consideration, we set the old field to undefined 
  // instead of deleting it
  currentField.set(context, undefined);
}

function parseExpr (expr) {
  if (!expr) return undefined;
  return new Expression(`${expr}`, { disallowAssign: true });
}

function renameFieldsOn(base) {
  if (typeof base !== 'object') return;

  // rename by key-value
  for (let i = 1; i < fields2rename.length; i += 2) {
    rename(fields2rename[i - 1], fields2rename[i], base);
  }

  // rename by expression
  if (renameExpr) {
    for (let [name, value] of Object.entries(base)) {
      const newName = renameExpr.evalOn({name, value});
      if (newName != null && name !== newName) {
        base[newName] = base[name];
        base[name] = undefined;
      }
    }  
  }
}


exports.init = (opts) => {
  const conf = opts.conf;
  fields2rename = [];
  baseFields = [];
  const rename = [];
  (conf.rename || []).forEach(field => {
    rename.push(getAccessor((field.currentName || '').trim()));
    rename.push(getAccessor((field.newName || '').trim()));
  });
  fields2rename = rename;

  const baseFieldSet = new Set((conf.baseFields || []).filter(x => x && x.trim().length));
  baseFields = [...baseFieldSet].map(getAccessor);
  
  renameExpr = parseExpr(conf.renameExpr);
};

exports.process = (event) => {
  if(!event) return event;

  if (fields2rename.length === 0 && !renameExpr) return event;

  // rename fields
  if(baseFields.length === 0) {
    renameFieldsOn(event); 
  } else {
    for (let y = 0; y < baseFields.length; y++) {
      renameFieldsOn(baseFields[y].get(event));
    }  
  }
  return event;
};

