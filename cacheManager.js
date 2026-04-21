// In-memory cache manager with TTL, LRU eviction, and namespacing

var DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
var DEFAULT_MAX_SIZE = 1000;
var DEFAULT_NAMESPACE = 'default';

// ---- CacheEntry ----

function CacheEntry(value, ttlMs) {
  this.value = value;
  this.createdAt = Date.now();
  this.expiresAt = ttlMs > 0 ? this.createdAt + ttlMs : Infinity;
  this.hits = 0;
  this.lastAccessedAt = this.createdAt;
}

CacheEntry.prototype.isExpired = function() {
  return Date.now() > this.expiresAt;
};

CacheEntry.prototype.touch = function() {
  this.hits++;
  this.lastAccessedAt = Date.now();
};

// ---- LRU list node ----

function LRUNode(key) {
  this.key = key;
  this.prev = null;
  this.next = null;
}

// ---- LRU list ----

function LRUList() {
  this.head = new LRUNode(null); // sentinel
  this.tail = new LRUNode(null); // sentinel
  this.head.next = this.tail;
  this.tail.prev = this.head;
  this.size = 0;
}

LRUList.prototype.addToFront = function(node) {
  node.next = this.head.next;
  node.prev = this.head;
  this.head.next.prev = node;
  this.head.next = node;
  this.size++;
};

LRUList.prototype.remove = function(node) {
  node.prev.next = node.next;
  node.next.prev = node.prev;
  node.prev = null;
  node.next = null;
  this.size--;
};

LRUList.prototype.moveToFront = function(node) {
  this.remove(node);
  this.addToFront(node);
};

LRUList.prototype.removeLast = function() {
  if (this.size === 0) return null;
  var last = this.tail.prev;
  this.remove(last);
  return last;
};

// ---- Cache namespace ----

function CacheNamespace(name, options) {
  this.name = name;
  this.maxSize = (options && options.maxSize) || DEFAULT_MAX_SIZE;
  this.defaultTtl = (options && options.ttlMs) || DEFAULT_TTL_MS;
  this.store = {};   // key -> CacheEntry
  this.nodes = {};   // key -> LRUNode
  this.lru = new LRUList();
  this.stats = { hits: 0, misses: 0, evictions: 0, expirations: 0, sets: 0, deletes: 0 };
}

CacheNamespace.prototype.set = function(key, value, ttlMs) {
  var ttl = typeof ttlMs === 'number' ? ttlMs : this.defaultTtl;

  if (this.store[key]) {
    // Update existing
    this.store[key] = new CacheEntry(value, ttl);
    this.lru.moveToFront(this.nodes[key]);
  } else {
    // Evict if at capacity
    if (this.lru.size >= this.maxSize) {
      var evicted = this.lru.removeLast();
      if (evicted) {
        delete this.store[evicted.key];
        delete this.nodes[evicted.key];
        this.stats.evictions++;
      }
    }
    var node = new LRUNode(key);
    this.store[key] = new CacheEntry(value, ttl);
    this.nodes[key] = node;
    this.lru.addToFront(node);
  }
  this.stats.sets++;
};

CacheNamespace.prototype.get = function(key) {
  var entry = this.store[key];
  if (!entry) {
    this.stats.misses++;
    return undefined;
  }
  if (entry.isExpired()) {
    this._delete(key);
    this.stats.expirations++;
    this.stats.misses++;
    return undefined;
  }
  entry.touch();
  this.lru.moveToFront(this.nodes[key]);
  this.stats.hits++;
  return entry.value;
};

CacheNamespace.prototype.has = function(key) {
  var entry = this.store[key];
  if (!entry) return false;
  if (entry.isExpired()) {
    this._delete(key);
    this.stats.expirations++;
    return false;
  }
  return true;
};

CacheNamespace.prototype._delete = function(key) {
  if (this.nodes[key]) {
    this.lru.remove(this.nodes[key]);
    delete this.nodes[key];
  }
  delete this.store[key];
};

CacheNamespace.prototype.delete = function(key) {
  if (!this.store[key]) return false;
  this._delete(key);
  this.stats.deletes++;
  return true;
};

CacheNamespace.prototype.clear = function() {
  this.store = {};
  this.nodes = {};
  this.lru = new LRUList();
};

CacheNamespace.prototype.purgeExpired = function() {
  var keys = Object.keys(this.store);
  var purged = 0;
  for (var i = 0; i < keys.length; i++) {
    if (this.store[keys[i]].isExpired()) {
      this._delete(keys[i]);
      this.stats.expirations++;
      purged++;
    }
  }
  return purged;
};

CacheNamespace.prototype.size = function() {
  return this.lru.size;
};

CacheNamespace.prototype.keys = function() {
  return Object.keys(this.store).filter(function(k) {
    return !this.store[k].isExpired();
  }, this);
};

CacheNamespace.prototype.getStats = function() {
  var total = this.stats.hits + this.stats.misses;
  return Object.assign({}, this.stats, {
    size: this.lru.size,
    hitRate: total > 0 ? (this.stats.hits / total) : 0,
  });
};

// ---- CacheManager ----

function CacheManager(globalOptions) {
  this.namespaces = {};
  this.globalOptions = globalOptions || {};
  this._purgeInterval = null;
}

CacheManager.prototype.namespace = function(name, options) {
  if (!this.namespaces[name]) {
    var opts = Object.assign({}, this.globalOptions, options || {});
    this.namespaces[name] = new CacheNamespace(name, opts);
  }
  return this.namespaces[name];
};

CacheManager.prototype.set = function(key, value, ttlMs, ns) {
  return this.namespace(ns || DEFAULT_NAMESPACE).set(key, value, ttlMs);
};

CacheManager.prototype.get = function(key, ns) {
  return this.namespace(ns || DEFAULT_NAMESPACE).get(key);
};

CacheManager.prototype.has = function(key, ns) {
  return this.namespace(ns || DEFAULT_NAMESPACE).has(key);
};

CacheManager.prototype.delete = function(key, ns) {
  return this.namespace(ns || DEFAULT_NAMESPACE).delete(key);
};

CacheManager.prototype.clear = function(ns) {
  if (ns) {
    if (this.namespaces[ns]) this.namespaces[ns].clear();
  } else {
    var names = Object.keys(this.namespaces);
    for (var i = 0; i < names.length; i++) {
      this.namespaces[names[i]].clear();
    }
  }
};

CacheManager.prototype.purgeExpired = function() {
  var total = 0;
  var names = Object.keys(this.namespaces);
  for (var i = 0; i < names.length; i++) {
    total += this.namespaces[names[i]].purgeExpired();
  }
  return total;
};

CacheManager.prototype.startAutoPurge = function(intervalMs) {
  var self = this;
  if (this._purgeInterval) clearInterval(this._purgeInterval);
  this._purgeInterval = setInterval(function() { self.purgeExpired(); }, intervalMs);
};

CacheManager.prototype.stopAutoPurge = function() {
  if (this._purgeInterval) {
    clearInterval(this._purgeInterval);
    this._purgeInterval = null;
  }
};

CacheManager.prototype.getStats = function() {
  var result = {};
  var names = Object.keys(this.namespaces);
  for (var i = 0; i < names.length; i++) {
    result[names[i]] = this.namespaces[names[i]].getStats();
  }
  return result;
};

// ---- Decorator: memoize ----

function memoize(fn, options) {
  var cache = new CacheManager(options);
  var ns = (options && options.namespace) || 'memo';
  var ttl = (options && options.ttlMs) || DEFAULT_TTL_MS;
  var keyFn = (options && options.keyFn) || function() {
    return JSON.stringify(Array.prototype.slice.call(arguments));
  };

  var wrapped = function() {
    var key = keyFn.apply(null, arguments);
    var cached = cache.get(key, ns);
    if (cached !== undefined) return cached;
    var result = fn.apply(this, arguments);
    cache.set(key, result, ttl, ns);
    return result;
  };

  wrapped.cache = cache;
  wrapped.invalidate = function() {
    var key = keyFn.apply(null, arguments);
    cache.delete(key, ns);
  };
  wrapped.clearAll = function() { cache.clear(ns); };
  return wrapped;
}

module.exports = {
  CacheManager: CacheManager,
  CacheNamespace: CacheNamespace,
  memoize: memoize,
};
