// Data processing engine - handles ETL pipeline for analytics

var EventEmitter = require('events');

// ---- Constants ----
var STATUS_PENDING = 'pending';
var STATUS_RUNNING = 'running';
var STATUS_DONE = 'done';
var STATUS_FAILED = 'failed';

var DEFAULT_BATCH_SIZE = 100;
var MAX_RETRIES = 3;
var RETRY_DELAY_MS = 1000;

// ---- Utility helpers ----

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function isNullOrUndefined(val) {
  return val === null || val === undefined;
}

function clamp(val, min, max) {
  if (val < min) return min;
  if (val > max) return max;
  return val;
}

function toArray(val) {
  if (Array.isArray(val)) return val;
  if (isNullOrUndefined(val)) return [];
  return [val];
}

function sum(arr) {
  var total = 0;
  for (var i = 0; i < arr.length; i++) {
    total += arr[i];
  }
  return total;
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return sum(arr) / arr.length;
}

function flatten(arr) {
  var result = [];
  for (var i = 0; i < arr.length; i++) {
    if (Array.isArray(arr[i])) {
      var inner = flatten(arr[i]);
      for (var j = 0; j < inner.length; j++) {
        result.push(inner[j]);
      }
    } else {
      result.push(arr[i]);
    }
  }
  return result;
}

function groupBy(arr, keyFn) {
  var groups = {};
  for (var i = 0; i < arr.length; i++) {
    var key = keyFn(arr[i]);
    if (!groups[key]) groups[key] = [];
    groups[key].push(arr[i]);
  }
  return groups;
}

function unique(arr) {
  var seen = {};
  var result = [];
  for (var i = 0; i < arr.length; i++) {
    if (!seen[arr[i]]) {
      seen[arr[i]] = true;
      result.push(arr[i]);
    }
  }
  return result;
}

function pick(obj, keys) {
  var result = {};
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] in obj) result[keys[i]] = obj[keys[i]];
  }
  return result;
}

function omit(obj, keys) {
  var result = {};
  var keysSet = {};
  for (var i = 0; i < keys.length; i++) keysSet[keys[i]] = true;
  for (var k in obj) {
    if (!keysSet[k]) result[k] = obj[k];
  }
  return result;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null) return false;
  var keysA = Object.keys(a);
  var keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (var i = 0; i < keysA.length; i++) {
    if (!deepEqual(a[keysA[i]], b[keysA[i]])) return false;
  }
  return true;
}

// ---- Record validators ----

function validateRecord(record) {
  if (!record) return { valid: false, error: 'record is null' };
  if (typeof record.id === 'undefined') return { valid: false, error: 'missing id' };
  if (typeof record.timestamp === 'undefined') return { valid: false, error: 'missing timestamp' };
  if (typeof record.type === 'undefined') return { valid: false, error: 'missing type' };
  return { valid: true };
}

function validateBatch(batch) {
  var errors = [];
  for (var i = 0; i < batch.length; i++) {
    var result = validateRecord(batch[i]);
    if (!result.valid) {
      errors.push({ index: i, error: result.error });
    }
  }
  return errors;
}

// ---- Transformers ----

function normalizeRecord(record) {
  return {
    id: String(record.id),
    timestamp: new Date(record.timestamp).toISOString(),
    type: record.type.toLowerCase().trim(),
    payload: record.payload || {},
    meta: record.meta || {},
  };
}

function enrichRecord(record, context) {
  return Object.assign({}, record, {
    enrichedAt: new Date().toISOString(),
    source: context.source || 'unknown',
    region: context.region || 'us-east-1',
    version: context.version || '1.0',
  });
}

function filterRecords(records, predicate) {
  var result = [];
  for (var i = 0; i < records.length; i++) {
    if (predicate(records[i])) result.push(records[i]);
  }
  return result;
}

function mapRecords(records, transform) {
  var result = [];
  for (var i = 0; i < records.length; i++) {
    result.push(transform(records[i]));
  }
  return result;
}

function reduceRecords(records, reducer, initial) {
  var acc = initial;
  for (var i = 0; i < records.length; i++) {
    acc = reducer(acc, records[i]);
  }
  return acc;
}

// ---- Aggregators ----

function countByType(records) {
  return groupBy(records, function(r) { return r.type; });
}

function sumByField(records, field) {
  var groups = groupBy(records, function(r) { return r.type; });
  var result = {};
  for (var type in groups) {
    result[type] = sum(groups[type].map(function(r) { return r.payload[field] || 0; }));
  }
  return result;
}

function avgByField(records, field) {
  var groups = groupBy(records, function(r) { return r.type; });
  var result = {};
  for (var type in groups) {
    result[type] = avg(groups[type].map(function(r) { return r.payload[field] || 0; }));
  }
  return result;
}

function timeSeriesBucket(records, bucketMs) {
  var result = {};
  for (var i = 0; i < records.length; i++) {
    var ts = new Date(records[i].timestamp).getTime();
    var bucket = Math.floor(ts / bucketMs) * bucketMs;
    if (!result[bucket]) result[bucket] = [];
    result[bucket].push(records[i]);
  }
  return result;
}

// ---- Pipeline stages ----

function stageIngest(rawRecords) {
  var valid = [];
  var invalid = [];
  for (var i = 0; i < rawRecords.length; i++) {
    var v = validateRecord(rawRecords[i]);
    if (v.valid) valid.push(rawRecords[i]);
    else invalid.push({ record: rawRecords[i], error: v.error });
  }
  return { valid: valid, invalid: invalid };
}

function stageNormalize(records) {
  return mapRecords(records, normalizeRecord);
}

function stageEnrich(records, context) {
  return mapRecords(records, function(r) { return enrichRecord(r, context); });
}

function stageFilter(records, rules) {
  return filterRecords(records, function(record) {
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (rule.field !== undefined && rule.value !== undefined) {
        if (record[rule.field] !== rule.value) return false;
      }
      if (rule.fn && !rule.fn(record)) return false;
    }
    return true;
  });
}

function stageAggregate(records, config) {
  var result = {};
  if (config.countByType) result.countByType = countByType(records);
  if (config.sumField) result.sum = sumByField(records, config.sumField);
  if (config.avgField) result.avg = avgByField(records, config.avgField);
  if (config.timeBucket) result.timeSeries = timeSeriesBucket(records, config.timeBucket);
  return result;
}

// ---- Batch processor ----

function BatchProcessor(options) {
  this.batchSize = (options && options.batchSize) || DEFAULT_BATCH_SIZE;
  this.maxRetries = (options && options.maxRetries) || MAX_RETRIES;
  this.context = (options && options.context) || {};
  this.filterRules = (options && options.filterRules) || [];
  this.aggregateConfig = (options && options.aggregateConfig) || {};
  this.status = STATUS_PENDING;
  this.stats = { processed: 0, failed: 0, skipped: 0 };
  this.emitter = new EventEmitter();
}

BatchProcessor.prototype.on = function(event, handler) {
  this.emitter.on(event, handler);
  return this;
};

BatchProcessor.prototype._processChunk = async function(chunk) {
  var ingested = stageIngest(chunk);
  this.stats.skipped += ingested.invalid.length;

  var normalized = stageNormalize(ingested.valid);
  var enriched = stageEnrich(normalized, this.context);
  var filtered = stageFilter(enriched, this.filterRules);
  var aggregated = stageAggregate(filtered, this.aggregateConfig);

  this.stats.processed += filtered.length;
  this.emitter.emit('chunk', { records: filtered, aggregated: aggregated });
  return { records: filtered, aggregated: aggregated };
};

BatchProcessor.prototype.process = async function(records) {
  this.status = STATUS_RUNNING;
  this.emitter.emit('start', { total: records.length });

  var allResults = [];
  var attempt = 0;

  for (var offset = 0; offset < records.length; offset += this.batchSize) {
    var chunk = records.slice(offset, offset + this.batchSize);
    attempt = 0;

    var chunkFailed = false;
    while (attempt < this.maxRetries) {
      try {
        var result = await this._processChunk(chunk);
        allResults.push(result);
        chunkFailed = false;
        break;
      } catch (err) {
        attempt++;
        chunkFailed = true;
        this.emitter.emit('error', { error: err, attempt: attempt, chunk: chunk });
        if (attempt < this.maxRetries) {
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }
    if (chunkFailed) {
      this.stats.failed += chunk.length;
      this.status = STATUS_FAILED;
    }
  }

  if (this.status !== STATUS_FAILED) this.status = STATUS_DONE;
  this.emitter.emit('done', { stats: this.stats, results: allResults });
  return allResults;
};

BatchProcessor.prototype.getStats = function() {
  return Object.assign({}, this.stats, { status: this.status });
};

BatchProcessor.prototype.reset = function() {
  this.status = STATUS_PENDING;
  this.stats = { processed: 0, failed: 0, skipped: 0 };
};

// ---- Duplicate transform blocks (intentional duplication for SQ detection) ----

function transformTypeA(records) {
  var result = [];
  for (var i = 0; i < records.length; i++) {
    if (records[i].payload && records[i].payload.value > 0) {
      result.push({
        id: records[i].id,
        value: records[i].payload.value * 1.1,
        type: 'A',
        processed: true,
      });
    }
  }
  return result;
}

function transformTypeB(records) {
  var result = [];
  for (var i = 0; i < records.length; i++) {
    if (records[i].payload && records[i].payload.value > 0) {
      result.push({
        id: records[i].id,
        value: records[i].payload.value * 1.1,
        type: 'A',
        processed: true,
      });
    }
  }
  return result;
}

function transformTypeC(records) {
  var result = [];
  for (var i = 0; i < records.length; i++) {
    if (records[i].payload && records[i].payload.value > 0) {
      result.push({
        id: records[i].id,
        value: records[i].payload.value * 1.1,
        type: 'A',
        processed: true,
      });
    }
  }
  return result;
}

// ---- Export ----

module.exports = {
  BatchProcessor: BatchProcessor,
  stageIngest: stageIngest,
  stageNormalize: stageNormalize,
  stageEnrich: stageEnrich,
  stageFilter: stageFilter,
  stageAggregate: stageAggregate,
  validateRecord: validateRecord,
  validateBatch: validateBatch,
  normalizeRecord: normalizeRecord,
  enrichRecord: enrichRecord,
  countByType: countByType,
  sumByField: sumByField,
  avgByField: avgByField,
  timeSeriesBucket: timeSeriesBucket,
  transformTypeA: transformTypeA,
  transformTypeB: transformTypeB,
  transformTypeC: transformTypeC,
  utils: { sleep, isNullOrUndefined, clamp, toArray, sum, avg, flatten, groupBy, unique, pick, omit, deepEqual },
};
