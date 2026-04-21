'use strict';

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function camelToKebab(str) {
  return str.replace(/([A-Z])/g, (_, c, offset) => (offset > 0 ? '-' : '') + c.toLowerCase());
}

function kebabToCamel(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function truncate(str, maxLength, suffix) {
  const end = suffix !== undefined ? suffix : '...';
  if (str.length <= maxLength) return str;
  if (maxLength <= end.length) return end.slice(0, maxLength);
  return str.slice(0, maxLength - end.length) + end;
}

function padStart(str, length, char) {
  const fill = char !== undefined ? char : ' ';
  let result = String(str);
  while (result.length < length) result = fill + result;
  return result;
}

function padEnd(str, length, char) {
  const fill = char !== undefined ? char : ' ';
  let result = String(str);
  while (result.length < length) result += fill;
  return result;
}

function countOccurrences(str, substring) {
  if (!substring) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(substring, pos)) !== -1) {
    count++;
    pos += substring.length;
  }
  return count;
}

function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

module.exports = { capitalize, camelToKebab, kebabToCamel, truncate, padStart, padEnd, countOccurrences, slugify };
