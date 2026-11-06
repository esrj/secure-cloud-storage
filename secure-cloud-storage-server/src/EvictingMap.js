/**
 * This file handles a map data structure where entries are removed after some time.
 */
import { EventEmitter } from 'node:events'

/**
 * A Map-like data structure where entries are automatically removed after a specified Time To Live (TTL).
 * When an entry is set or updated, its timer is reset.
 */
export default class EvictingMap extends Map {
  /**
   * Creates an instance of EvictingMap.
   * @param {number} ttl - The time to live for entries in milliseconds.
   * @param {Iterable<[any, any]>} [initialEntries=[]] - Optional initial entries for the map.
   */
  constructor(ttl, initialEntries = []) {
    if (typeof ttl !== 'number' || ttl <= 0) {
      throw new Error('TTL must be a positive number in milliseconds.')
    }
    super()
    this.ttl = ttl // Time to live for each entry
    this.timers = new Map() // Stores setTimeout IDs for each key
    this.emitter = new EventEmitter() // Use an internal EventEmitter instance

    // Add initial entries if provided, ensuring their timers are set
    for (const [key, value] of initialEntries) {
      this.set(key, value)
    }
  }

  /**
   * Sets a key-value pair in the map. Resets the timer for the key if it already exists.
   * @param {any} key - The key of the element to add to the Map object.
   * @param {any} value - The value of the element to add to the Map object.
   * @returns {EvictingMap} The Map object.
   */
  set(key, value) {
    // Clear any existing timer for this key
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key))
    }

    // Set a new timer to delete the key after this.ttl
    const timerId = setTimeout(() => {
      // Check if the timer still belongs to the current entry (prevents race conditions if updated)
      if (this.timers.get(key) === timerId) {
        this.#handleExpiredEntry(key) // Call the dedicated handler for time-based removal
        // console.log(`Key "${key}" expired and was removed.`); // For debugging
      }
    }, this.ttl)

    this.timers.set(key, timerId) // Store the timer ID
    return super.set(key, value) // Call the native Map's set method
  }

  /**
   * Internal method to handle the actual expiration logic and cleanup.
   * This is where you can perform operations specific to time-based removal.
   * @private
   * @param {any} key - The key of the expired entry.
   */
  #handleExpiredEntry(key) {
    // Get the value *before* it's removed from the underlying map.
    const value = super.get(key)

    // Perform cleanup: remove timer ID and remove from the map
    this.timers.delete(key)
    super.delete(key) // Perform the actual removal from the map

    // --- PERFORM YOUR OPERATION HERE ---
    // This is the point where an entry is removed by time.
    // You have access to both `key` and `value`.
    // Example: Log the removal, clean up associated resources, etc.
    // console.log(`[EvictingMap] Key "${key}" with value "${JSON.stringify(value)}" expired and was removed.`);

    // Emit an event to notify subscribers about the expiration
    this.emitter.emit('expired', key, value)
  }

  /**
   * Returns a specified element from the Map object.
   * Note: Accessing an element with get() does NOT reset its timer in this implementation.
   * If you want to reset the timer on access (LRU-like behavior), you would call this.set(key, this.get(key)) here.
   * @param {any} key - The key of the element to return from the Map object.
   * @returns {any | undefined} The element associated with the specified key, or undefined if the key can't be found in the Map object.
   */
  get(key) {
    return super.get(key)
  }

  /**
   * Removes the specified element from a Map object.
   * Clears the associated timer.
   * @param {any} key - The key of the element to remove from the Map object.
   * @returns {boolean} true if an element in the Map object has been removed successfully or false otherwise.
   */
  delete(key) {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key))
      this.timers.delete(key) // Remove the timer ID from our internal map
    }
    return super.delete(key) // Call the native Map's delete method
  }

  /**
   * Removes all elements from the Map object.
   * Clears all associated timers.
   */
  clear() {
    for (const timerId of this.timers.values()) {
      clearTimeout(timerId) // Clear all scheduled timers
    }
    this.timers.clear() // Clear our internal timers map
    super.clear() // Call the native Map's clear method
  }

  /**
   * Returns a boolean indicating whether an element with the specified key exists in the Map object.
   * @param {any} key - The key of the element to test for presence in the Map object.
   * @returns {boolean} true if an element with the specified key exists in the Map object; otherwise false.
   */
  has(key) {
    return super.has(key)
  }

  /**
   * Registers a callback to be invoked when an entry expires.
   * @param {(key: any, value: any) => void} callback - The function to call when an entry expires.
   */
  onExpired(callback) {
    this.emitter.on('expired', callback)
  }

  /**
   * Removes a previously registered callback for expiration events.
   * @param {(key: any, value: any) => void} callback - The function to remove.
   */
  offExpired(callback) {
    this.emitter.off('expired', callback)
  }

  // You might also want to override other methods like forEach, keys, values, entries
  // to ensure they work with the actual values and not the internal { value, timerId } structure,
  // but for basic usage, the inherited methods will work if you expect a Map.entries() call
  // to give you [key, {value, timerId}] pairs. If you want [key, value] pairs, you need to iterate and transform.

  // Example of overriding entries() to return just key, value:
  // *[Symbol.iterator]() {
  //   for (const [key, value] of super.entries()) {
  //     yield [key, value]
  //   }
  // }

  *entries() {
    for (const [key, value] of super.entries()) {
      yield [key, value]
    }
  }

  *values() {
    for (const value of super.values()) {
      yield value
    }
  }
}
console.debug('EvictingMap.js loaded.')