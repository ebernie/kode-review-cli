import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LRUCache } from '../cache.js'

describe('LRUCache', () => {
  describe('constructor', () => {
    it('throws when maxSize is zero', () => {
      expect(() => new LRUCache({ maxSize: 0, ttlMs: 1000 })).toThrow('maxSize must be greater than 0')
    })

    it('throws when maxSize is negative', () => {
      expect(() => new LRUCache({ maxSize: -1, ttlMs: 1000 })).toThrow('maxSize must be greater than 0')
    })

    it('throws when ttlMs is zero', () => {
      expect(() => new LRUCache({ maxSize: 10, ttlMs: 0 })).toThrow('ttlMs must be greater than 0')
    })

    it('throws when ttlMs is negative', () => {
      expect(() => new LRUCache({ maxSize: 10, ttlMs: -1 })).toThrow('ttlMs must be greater than 0')
    })

    it('accepts valid options', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1000 })
      expect(cache.size).toBe(0)
    })
  })

  describe('get/set', () => {
    it('returns undefined for non-existent keys', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1000 })
      expect(cache.get('nonexistent')).toBeUndefined()
    })

    it('stores and retrieves values', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1000 })
      cache.set('key1', 100)
      expect(cache.get('key1')).toBe(100)
    })

    it('overwrites existing values', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1000 })
      cache.set('key1', 100)
      cache.set('key1', 200)
      expect(cache.get('key1')).toBe(200)
      expect(cache.size).toBe(1)
    })

    it('handles different key types', () => {
      const cache = new LRUCache<number, string>({ maxSize: 10, ttlMs: 1000 })
      cache.set(1, 'one')
      cache.set(2, 'two')
      expect(cache.get(1)).toBe('one')
      expect(cache.get(2)).toBe('two')
    })
  })

  describe('LRU eviction', () => {
    it('evicts least recently used entry when full', () => {
      const cache = new LRUCache<string, number>({ maxSize: 3, ttlMs: 10000 })

      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      // Cache is full, add one more should evict 'a'
      cache.set('d', 4)

      expect(cache.get('a')).toBeUndefined()
      expect(cache.get('b')).toBe(2)
      expect(cache.get('c')).toBe(3)
      expect(cache.get('d')).toBe(4)
    })

    it('accessing a key moves it to most recently used', () => {
      const cache = new LRUCache<string, number>({ maxSize: 3, ttlMs: 10000 })

      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      // Access 'a', making it most recently used
      cache.get('a')

      // Add 'd', should evict 'b' (now least recently used)
      cache.set('d', 4)

      expect(cache.get('a')).toBe(1)
      expect(cache.get('b')).toBeUndefined()
      expect(cache.get('c')).toBe(3)
      expect(cache.get('d')).toBe(4)
    })

    it('setting a key moves it to most recently used', () => {
      const cache = new LRUCache<string, number>({ maxSize: 3, ttlMs: 10000 })

      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      // Update 'a', making it most recently used
      cache.set('a', 100)

      // Add 'd', should evict 'b' (now least recently used)
      cache.set('d', 4)

      expect(cache.get('a')).toBe(100)
      expect(cache.get('b')).toBeUndefined()
      expect(cache.get('c')).toBe(3)
      expect(cache.get('d')).toBe(4)
    })

    it('handles cache size of 1', () => {
      const cache = new LRUCache<string, number>({ maxSize: 1, ttlMs: 10000 })

      cache.set('a', 1)
      expect(cache.get('a')).toBe(1)

      cache.set('b', 2)
      expect(cache.get('a')).toBeUndefined()
      expect(cache.get('b')).toBe(2)
    })
  })

  describe('TTL expiration', () => {
    let originalDateNow: () => number
    let currentTime: number

    beforeEach(() => {
      originalDateNow = Date.now
      currentTime = originalDateNow.call(Date)
      Date.now = () => currentTime
    })

    afterEach(() => {
      Date.now = originalDateNow
    })

    function advanceTime(ms: number) {
      currentTime += ms
    }

    it('returns value before TTL expires', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1000 })
      cache.set('key', 42)

      advanceTime(500)
      expect(cache.get('key')).toBe(42)
    })

    it('returns undefined after TTL expires', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1000 })
      cache.set('key', 42)

      advanceTime(1001)
      expect(cache.get('key')).toBeUndefined()
    })

    it('removes expired entry from cache on access', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1000 })
      cache.set('key', 42)

      expect(cache.size).toBe(1)

      advanceTime(1001)
      cache.get('key')

      expect(cache.size).toBe(0)
    })

    it('has() returns false for expired entries', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1000 })
      cache.set('key', 42)

      expect(cache.has('key')).toBe(true)

      advanceTime(1001)
      expect(cache.has('key')).toBe(false)
    })

    it('prune() removes expired entries', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1000 })
      cache.set('key1', 1)
      cache.set('key2', 2)

      advanceTime(500)
      cache.set('key3', 3) // Added later, expires later

      advanceTime(501) // key1 and key2 expire, key3 still valid

      const pruned = cache.prune()
      expect(pruned).toBe(2)
      expect(cache.size).toBe(1)
      expect(cache.get('key3')).toBe(3)
    })
  })

  describe('has', () => {
    it('returns true for existing non-expired keys', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 10000 })
      cache.set('key', 42)
      expect(cache.has('key')).toBe(true)
    })

    it('returns false for non-existent keys', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 10000 })
      expect(cache.has('key')).toBe(false)
    })
  })

  describe('delete', () => {
    it('removes existing key and returns true', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 10000 })
      cache.set('key', 42)

      expect(cache.delete('key')).toBe(true)
      expect(cache.get('key')).toBeUndefined()
      expect(cache.size).toBe(0)
    })

    it('returns false for non-existent key', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 10000 })
      expect(cache.delete('nonexistent')).toBe(false)
    })
  })

  describe('clear', () => {
    it('removes all entries', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 10000 })
      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      cache.clear()

      expect(cache.size).toBe(0)
      expect(cache.get('a')).toBeUndefined()
      expect(cache.get('b')).toBeUndefined()
      expect(cache.get('c')).toBeUndefined()
    })
  })

  describe('size', () => {
    it('returns correct size after operations', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 10000 })

      expect(cache.size).toBe(0)

      cache.set('a', 1)
      expect(cache.size).toBe(1)

      cache.set('b', 2)
      expect(cache.size).toBe(2)

      cache.delete('a')
      expect(cache.size).toBe(1)

      cache.clear()
      expect(cache.size).toBe(0)
    })
  })
})
