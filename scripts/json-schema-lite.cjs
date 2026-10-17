"use strict";
// The JSON Schema keywords results.js's schemas use (2020-12 meaning):
// type (string or list, "integer" = whole number), const, enum, pattern,
// required, properties, additionalProperties: false, items.  Returns a list
// of "path: problem" strings; empty when the value is valid.  Anything else
// in a schema is an error, so the schema cannot silently use a keyword this
// checker ignores.
const KNOWN = new Set(["$schema", "$id", "title", "description", "type", "const", "enum", "pattern", "required", "properties", "additionalProperties", "items"]);

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

function validate(schema, value, path, errors) {
  const at = path || "$";
  const out = errors || [];
  Object.keys(schema).forEach(function (key) {
    if (!KNOWN.has(key)) out.push(at + ": schema keyword " + key + " is not supported by this checker");
  });
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(function (t) { return matchesType(value, t); })) {
      out.push(at + ": " + typeOf(value) + " is not " + types.join(" or "));
      return out;
    }
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) out.push(at + ": must be " + JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.some(function (v) { return JSON.stringify(v) === JSON.stringify(value); })) out.push(at + ": " + JSON.stringify(value) + " not in enum");
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern, "u").test(value)) out.push(at + ": " + value + " does not match " + schema.pattern);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    (schema.required || []).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) out.push(at + ": missing " + key);
    });
    const properties = schema.properties || {};
    Object.keys(value).forEach(function (key) {
      if (properties[key]) {
        validate(properties[key], value[key], at + "." + key, out);
      } else if (schema.additionalProperties === false) {
        out.push(at + ": unexpected property " + key);
      }
    });
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach(function (item, index) { validate(schema.items, item, at + "[" + index + "]", out); });
  }
  return out;
}

module.exports = { validate: validate };
