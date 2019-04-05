/**
 * Copyright (c) 2002-2019 "Neo4j,"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import PoolConfig from './pool-config'
import { newError } from '../error'
import Logger from './logger'

class Pool {
  /**
   * @param {function(function): Promise<object>} create  an allocation function that creates a promise with a new resource. It's given
   *                a single argument, a function that will return the resource to
   *                the pool if invoked, which is meant to be called on .dispose
   *                or .close or whatever mechanism the resource uses to finalize.
   * @param {function} destroy called with the resource when it is evicted from this pool
   * @param {function} validate called at various times (like when an instance is acquired and
   *                 when it is returned). If this returns false, the resource will
   *                 be evicted
   * @param {PoolConfig} config configuration for the new driver.
   * @param {Logger} log the driver logger.
   */
  constructor (create, destroy = (() => true), validate = (() => true), config = PoolConfig.defaultConfig(),
    log = Logger.noOp()) {
    this._create = create
    this._destroy = destroy
    this._validate = validate
    this._maxSize = config.maxSize
    this._acquisitionTimeout = config.acquisitionTimeout
    this._pools = {}
    this._acquireRequests = {}
    this._activeResourceCounts = {}
    this._release = this._release.bind(this)
    this._log = log
  }

  /**
   * Acquire and idle resource fom the pool or create a new one.
   * @param {string} key the resource key.
   * @return {object} resource that is ready to use.
   */
  acquire (key) {
    return this._acquire(key).then(resource => {
      if (resource) {
        resourceAcquired(key, this._activeResourceCounts)
        if (this._log.isDebugEnabled()) {
          this._log.debug(`${resource} acquired from the pool`)
        }
        return resource
      }

      // We're out of resources and will try to acquire later on when an existing resource is released.
      const allRequests = this._acquireRequests
      const requests = allRequests[key]
      if (!requests) {
        allRequests[key] = []
      }

      return new Promise((resolve, reject) => {
        let request

        const timeoutId = setTimeout(() => {
          // acquisition timeout fired

          // remove request from the queue of pending requests, if it's still there
          // request might've been taken out by the release operation
          const pendingRequests = allRequests[key]
          if (pendingRequests) {
            allRequests[key] = pendingRequests.filter(item => item !== request)
          }

          if (request.isCompleted()) {
            // request already resolved/rejected by the release operation; nothing to do
          } else {
            // request is still pending and needs to be failed
            request.reject(newError(`Connection acquisition timed out in ${this._acquisitionTimeout} ms.`))
          }
        }, this._acquisitionTimeout)

        request = new PendingRequest(resolve, reject, timeoutId, this._log)
        allRequests[key].push(request)
      })
    })
  }

  /**
   * Destroy all idle resources for the given key.
   * @param {string} key the resource key to purge.
   */
  purge (key) {
    const pool = this._pools[key] || []
    while (pool.length) {
      const resource = pool.pop()
      this._destroy(resource)
    }
    delete this._pools[key]
  }

  /**
   * Destroy all idle resources in this pool.
   */
  purgeAll () {
    Object.keys(this._pools).forEach(key => this.purge(key))
  }

  /**
   * Check if this pool contains resources for the given key.
   * @param {string} key the resource key to check.
   * @return {boolean} `true` when pool contains entries for the given key, <code>false</code> otherwise.
   */
  has (key) {
    return (key in this._pools)
  }

  /**
   * Get count of active (checked out of the pool) resources for the given key.
   * @param {string} key the resource key to check.
   * @return {number} count of resources acquired by clients.
   */
  activeResourceCount (key) {
    return this._activeResourceCounts[key] || 0
  }

  _acquire (key) {
    let pool = this._pools[key]
    if (!pool) {
      pool = []
      this._pools[key] = pool
    }
    while (pool.length) {
      const resource = pool.pop()

      if (this._validate(resource)) {
        // idle resource is valid and can be acquired
        return Promise.resolve(resource)
      } else {
        this._destroy(resource)
      }
    }

    if (this._maxSize && this.activeResourceCount(key) >= this._maxSize) {
      return Promise.resolve(null)
    }

    // there exist no idle valid resources, create a new one for acquisition
    return this._create(key, this._release)
  }

  _release (key, resource) {
    const pool = this._pools[key]

    if (pool) {
      // there exist idle connections for the given key
      if (!this._validate(resource)) {
        if (this._log.isDebugEnabled()) {
          this._log.debug(`${resource} destroyed and can't be released to the pool ${key} because it is not functional`)
        }
        this._destroy(resource)
      } else {
        if (this._log.isDebugEnabled()) {
          this._log.debug(`${resource} released to the pool ${key}`)
        }
        pool.push(resource)
      }
    } else {
      // key has been purged, don't put it back, just destroy the resource
      if (this._log.isDebugEnabled()) {
        this._log.debug(`${resource} destroyed and can't be released to the pool ${key} because pool has been purged`)
      }
      this._destroy(resource)
    }
    resourceReleased(key, this._activeResourceCounts)

    this._processPendingAcquireRequests(key)
  }

  _processPendingAcquireRequests (key) {
    const requests = this._acquireRequests[key]
    if (requests) {
      const pendingRequest = requests.shift() // pop a pending acquire request

      if (pendingRequest) {
        this._acquire(key)
          .catch(error => {
            // failed to acquire/create a new connection to resolve the pending acquire request
            // propagate the error by failing the pending request
            pendingRequest.reject(error)
            return null
          })
          .then(resource => {
            if (resource) {
              // managed to acquire a valid resource from the pool

              if (pendingRequest.isCompleted()) {
                // request has been completed, most likely failed by a timeout
                // return the acquired resource back to the pool
                this._release(key, resource)
              } else {
                // request is still pending and can be resolved with the newly acquired resource
                resourceAcquired(key, this._activeResourceCounts) // increment the active counter
                pendingRequest.resolve(resource) // resolve the pending request with the acquired resource
              }
            }
          })
      } else {
        delete this._acquireRequests[key]
      }
    }
  }
}

/**
 * Increment active (checked out of the pool) resource counter.
 * @param {string} key the resource group identifier (server address for connections).
 * @param {Object.<string, number>} activeResourceCounts the object holding active counts per key.
 */
function resourceAcquired (key, activeResourceCounts) {
  const currentCount = activeResourceCounts[key] || 0
  activeResourceCounts[key] = currentCount + 1
}

/**
 * Decrement active (checked out of the pool) resource counter.
 * @param {string} key the resource group identifier (server address for connections).
 * @param {Object.<string, number>} activeResourceCounts the object holding active counts per key.
 */
function resourceReleased (key, activeResourceCounts) {
  const currentCount = activeResourceCounts[key] || 0
  const nextCount = currentCount - 1

  if (nextCount > 0) {
    activeResourceCounts[key] = nextCount
  } else {
    delete activeResourceCounts[key]
  }
}

class PendingRequest {
  constructor (resolve, reject, timeoutId, log) {
    this._resolve = resolve
    this._reject = reject
    this._timeoutId = timeoutId
    this._log = log
    this._completed = false
  }

  isCompleted () {
    return this._completed
  }

  resolve (resource) {
    if (this._completed) {
      return
    }
    this._completed = true

    clearTimeout(this._timeoutId)
    if (this._log.isDebugEnabled()) {
      this._log.debug(`${resource} acquired from the pool`)
    }
    this._resolve(resource)
  }

  reject (error) {
    if (this._completed) {
      return
    }
    this._completed = true

    clearTimeout(this._timeoutId)
    this._reject(error)
  }
}

export default Pool
