function isIsoLikeDateString(s) {
  return /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(s);
}
function isValidTypescriptIdentifier(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
function singularizeWord(word) {
  const t = String(word || "");
  if (/ies$/i.test(t)) return t.replace(/ies$/i, "y");
  if (/ses$/i.test(t)) return t.replace(/es$/i, "s");
  if (/xes$|zes$|ches$|shes$/i.test(t)) return t.replace(/es$/i, "");
  if (/s$/i.test(t) && !/ss$/i.test(t)) return t.slice(0, -1);
  return t || "Item";
}

module.exports = { isIsoLikeDateString, isValidTypescriptIdentifier, singularizeWord };