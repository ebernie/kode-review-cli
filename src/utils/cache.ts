/**
 * LRU Cache with TTL support
 *
 * Provides a simple in-memory cache with:
 * - Least Recently Used (LRU) eviction policy
 * - Time-To-Live (TTL) based expiration
 * - O(1) get/set/delete operations using Map
 */

export interface CacheOptions {
  /** Maximum number of entries in the cache */
  maxSize: number
  /** Time-to-live in milliseconds for each entry */
  ttlMs: number
}

interface CacheEntry<V> {
  value: V
  expiresAt: number
}

/**
 * LRU Cache implementation with TTL support
 *
 * Uses a Map to maintain insertion order, which we leverage for LRU eviction.
 * When an entry is accessed, it's moved to the end of the Map.
 * When the cache is full, the oldest entry (first in the Map) is evicted.
 */
export class LRUCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>()
  private readonly maxSize: number
  private readonly ttlMs: number

  constructor(options: CacheOptions) {
    if (options.maxSize <= 0) {
      throw new Error('maxSize must be greater than 0')
    }
    if (options.ttlMs <= 0) {
      throw new Error('ttlMs must be greater than 0')
    }

    this.maxSize = options.maxSize
    this.ttlMs = options.ttlMs
  }

  /**
   * Get a value from the cache
   *
   * Returns undefined if the key doesn't exist or has expired.
   * Accessing a key moves it to the "most recently used" position.
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key)

    if (!entry) {
      return undefined
    }

    // Check if entry has expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }

    // Move to end (most recently used) by re-inserting
    this.cache.delete(key)
    this.cache.set(key, entry)

    return entry.value
  }

  /**
   * Set a value in the cache
   *
   * If the key already exists, it's updated and moved to "most recently used".
   * If the cache is full, the least recently used entry is evicted.
   */
  set(key: K, value: V): void {
    // Delete existing entry if present (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey)
      } else {
        break
      }
    }

    // Add new entry
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  /**
   * Check if a key exists and is not expired
   */
  has(key: K): boolean {
    const entry = this.cache.get(key)

    if (!entry) {
      return false
    }

    // Check if entry has expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return false
    }

    return true
  }

  /**
   * Delete a key from the cache
   */
  delete(key: K): boolean {
    return this.cache.delete(key)
  }

  /**
   * Clear all entries from the cache
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Get the current number of entries in the cache
   * Note: This includes expired entries that haven't been cleaned up yet
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * Remove all expired entries from the cache
   * Call this periodically if you need to reclaim memory from expired entries
   */
  prune(): number {
    const now = Date.now()
    let pruned = 0

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
        pruned++
      }
    }

    return pruned
  }
}
