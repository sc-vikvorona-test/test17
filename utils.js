// Click history tracker
const history = [];
function trackClick(element) {
  history.push({ element, time: Date.now() });
}
function getHistory() { return history; }
module.exports = { trackClick, getHistory };
// variant 8
// improvement: add clear function - 8
