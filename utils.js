function formatNumber(n) {
  return n.toFixed(2);
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

module.exports = { formatNumber, clamp };
