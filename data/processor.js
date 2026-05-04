// Data processing module - extracted and improved from utils.js

function processData(data) {
  if (!data || !data.items) return 0;
  const active = data.items.filter(item => item && item.active);
  const inRange = active.filter(item => item.value > 0 && item.value < 100);
  return inRange.length > 0 ? inRange[0].value * 2 : 0;
}

function transformPositive(arr) {
  return arr.filter(n => n > 0).map(n => n * 2);
}

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const group = item[key];
    if (!acc[group]) acc[group] = [];
    acc[group].push(item);
    return acc;
  }, {});
}

function sortBy(arr, key, direction) {
  return [...arr].sort((a, b) => {
    if (direction === "desc") return b[key] - a[key];
    return a[key] - b[key];
  });
}

function paginate(arr, page, pageSize) {
  const start = (page - 1) * pageSize;
  return arr.slice(start, start + pageSize);
}

module.exports = { processData, transformPositive, groupBy, sortBy, paginate };
