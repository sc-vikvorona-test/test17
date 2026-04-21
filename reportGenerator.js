// Report generation module - generates various analytics reports

var fs = require('fs');
var path = require('path');

// ---- Formatters ----

function formatCurrency(amount, currency) {
  currency = currency || 'USD';
  if (typeof amount !== 'number') return 'N/A';
  return currency + ' ' + amount.toFixed(2);
}

function formatPercent(value, total) {
  if (!total || total === 0) return '0.00%';
  return ((value / total) * 100).toFixed(2) + '%';
}

function formatDate(ts) {
  var d = new Date(ts);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function formatDuration(ms) {
  var seconds = Math.floor(ms / 1000);
  var minutes = Math.floor(seconds / 60);
  var hours = Math.floor(minutes / 60);
  if (hours > 0) return hours + 'h ' + (minutes % 60) + 'm';
  if (minutes > 0) return minutes + 'm ' + (seconds % 60) + 's';
  return seconds + 's';
}

function padRight(str, len) {
  str = String(str);
  while (str.length < len) str += ' ';
  return str;
}

function padLeft(str, len) {
  str = String(str);
  while (str.length < len) str = ' ' + str;
  return str;
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

// ---- Table builder ----

function buildTable(headers, rows) {
  var colWidths = headers.map(function(h) { return h.length; });
  for (var i = 0; i < rows.length; i++) {
    for (var j = 0; j < rows[i].length; j++) {
      var cellLen = String(rows[i][j]).length;
      if (cellLen > colWidths[j]) colWidths[j] = cellLen;
    }
  }

  var separator = '+' + colWidths.map(function(w) {
    var s = '';
    for (var i = 0; i < w + 2; i++) s += '-';
    return s;
  }).join('+') + '+';

  var lines = [separator];
  var headerLine = '|' + headers.map(function(h, i) {
    return ' ' + padRight(h, colWidths[i]) + ' ';
  }).join('|') + '|';
  lines.push(headerLine);
  lines.push(separator);

  for (var r = 0; r < rows.length; r++) {
    var rowLine = '|' + rows[r].map(function(cell, i) {
      return ' ' + padRight(String(cell), colWidths[i]) + ' ';
    }).join('|') + '|';
    lines.push(rowLine);
  }
  lines.push(separator);
  return lines.join('\n');
}

// ---- Report types ----

function buildSummaryReport(data) {
  var lines = [];
  lines.push('=== SUMMARY REPORT ===');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('');
  lines.push('Total records: ' + data.total);
  lines.push('Processed:     ' + data.processed);
  lines.push('Failed:        ' + data.failed);
  lines.push('Skipped:       ' + data.skipped);
  lines.push('');
  lines.push('Success rate:  ' + formatPercent(data.processed, data.total));
  lines.push('Duration:      ' + formatDuration(data.durationMs));
  return lines.join('\n');
}

function buildTypeBreakdownReport(countByType) {
  var headers = ['Type', 'Count', 'Percent'];
  var total = 0;
  var types = Object.keys(countByType);
  for (var i = 0; i < types.length; i++) {
    total += countByType[types[i]].length || countByType[types[i]];
  }
  var rows = types.map(function(type) {
    var count = countByType[type].length || countByType[type];
    return [type, count, formatPercent(count, total)];
  });
  return '=== TYPE BREAKDOWN ===\n' + buildTable(headers, rows);
}

function buildTimeSeriesReport(timeSeries, bucketMs) {
  var buckets = Object.keys(timeSeries).sort();
  var headers = ['Bucket', 'Date', 'Count'];
  var rows = buckets.map(function(bucket) {
    return [bucket, formatDate(parseInt(bucket, 10)), timeSeries[bucket].length];
  });
  return '=== TIME SERIES (bucket=' + formatDuration(bucketMs) + ') ===\n' + buildTable(headers, rows);
}

function buildErrorReport(errors) {
  if (!errors || errors.length === 0) return '=== ERRORS ===\nNo errors recorded.\n';
  var lines = ['=== ERRORS ==='];
  for (var i = 0; i < errors.length; i++) {
    lines.push('[' + (i + 1) + '] ' + (errors[i].message || String(errors[i])));
    if (errors[i].stack) lines.push('    ' + errors[i].stack.split('\n')[1]);
  }
  return lines.join('\n');
}

function buildTopNReport(records, field, n) {
  n = n || 10;
  var sorted = records.slice().sort(function(a, b) {
    var va = (a.payload && a.payload[field]) || 0;
    var vb = (b.payload && b.payload[field]) || 0;
    return vb - va;
  });
  var top = sorted.slice(0, n);
  var headers = ['Rank', 'ID', field, 'Type'];
  var rows = top.map(function(r, i) {
    return [i + 1, truncate(r.id, 20), (r.payload && r.payload[field]) || 'N/A', r.type];
  });
  return '=== TOP ' + n + ' by ' + field + ' ===\n' + buildTable(headers, rows);
}

// ---- Full report composer ----

function composeFullReport(data) {
  var sections = [];

  sections.push(buildSummaryReport({
    total: data.totalRecords,
    processed: data.stats.processed,
    failed: data.stats.failed,
    skipped: data.stats.skipped,
    durationMs: data.durationMs,
  }));

  if (data.aggregated && data.aggregated.countByType) {
    sections.push(buildTypeBreakdownReport(data.aggregated.countByType));
  }

  if (data.aggregated && data.aggregated.timeSeries) {
    sections.push(buildTimeSeriesReport(data.aggregated.timeSeries, data.bucketMs || 3600000));
  }

  if (data.topField && data.records) {
    sections.push(buildTopNReport(data.records, data.topField, 10));
  }

  if (data.errors && data.errors.length > 0) {
    sections.push(buildErrorReport(data.errors));
  }

  return sections.join('\n\n');
}

// ---- File writer ----

function writeReport(report, outputDir, filename) {
  var filePath = path.join(outputDir, filename);
  fs.writeFileSync(filePath, report, 'utf8');
  return filePath;
}

function writeReportJson(data, outputDir, filename) {
  var filePath = path.join(outputDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return filePath;
}

module.exports = {
  formatCurrency: formatCurrency,
  formatPercent: formatPercent,
  formatDate: formatDate,
  formatDuration: formatDuration,
  buildTable: buildTable,
  buildSummaryReport: buildSummaryReport,
  buildTypeBreakdownReport: buildTypeBreakdownReport,
  buildTimeSeriesReport: buildTimeSeriesReport,
  buildErrorReport: buildErrorReport,
  buildTopNReport: buildTopNReport,
  composeFullReport: composeFullReport,
  writeReport: writeReport,
  writeReportJson: writeReportJson,
};
