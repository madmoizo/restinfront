import RestinfrontError from './RestinfrontError.js'
import {
  has,
  isArray,
  isDate,
  isFunction,
  isObject,
  isString,
  joinPaths,
  typecheck
} from 'utilib'


const COLLECTION_SYMBOL = Symbol.for('collection')
const COLLECTION_KEY = 'collection'

export default class Model {
  static baseUrl = ''
  static endpoint = ''
  static authentication = false
  static schema = false
  static primaryKeyFieldname = null
  static collectionDataKey = 'rows'
  static collectionCountKey = 'count'
  static onValidationError = () => null
  static onFetchError = () => null

  /*****************************************************************
  * Static: Public API
  *****************************************************************/

  /**
   * Build an item based on the schema and filled with default values
   * @param {object} options
   * @param {string} [options.baseUrl]
   * @param {string} [options.endpoint]
   * @param {string} [options.collectionDataKey]
   * @param {string} [options.collectionCountKey]
   * @param {function|false} [options.authentication]
   * @param {object|false} [options.schema]
   * @param {function} [options.onValidationError]
   * @param {function} [options.onFetchError]
   * @returns {Model}
   */
  static init (options = {}) {
    typecheck({
      options: {
        value: options,
        type: ['object', {
          baseUrl: { type: 'string' },
          endpoint: { type: 'string' },
          collectionDataKey: { type: 'string' },
          collectionCountKey: { type: 'string' },
          authentication: { type: ['function', 'false'] },
          schema: { type: ['object', 'false'] },
          onValidationError: { type: 'function' },
          onFetchError: { type: 'function' }
        }]
      }
    }, {
      onError: (message) => {
        throw new RestinfrontError(message)
      }
    })

    // Set options
    const assignables = [
      'baseUrl',
      'endpoint',
      'collectionDataKey',
      'collectionCountKey',
      'authentication',
      'schema',
      'onValidationError',
      'onFetchError'
    ]
    assignables.forEach(prop => {
      if (has(options, prop)) {
        this[prop] = options[prop]
      }
    })

    // Parse schema fields to set default values for each option
    if (this.schema) {
      // Clone the schema before mutating it
      this.schema = structuredClone(this.schema)

      for (const [fieldname, fieldconf] of Object.entries(this.schema)) {
        // Type is a required param
        if (!has(fieldconf, 'type')) {
          throw new RestinfrontError(`\`type\` field attribute is required on \`${fieldname}\` field of ${this.name} model`)
        }

        // Set the primary key
        if (fieldconf.primaryKey) {
          this.primaryKeyFieldname = fieldname
        }

        // Define the default value
        const defaultValue = has(fieldconf, 'defaultValue')
          ? fieldconf.defaultValue
          : fieldconf.type.defaultValue
        // Optimization: Ensure defaultValue is a function (avoid type check on runtime)
        fieldconf.defaultValue = isFunction(defaultValue)
          ? defaultValue
          : () => defaultValue

        // Default blank is restricted
        const allowBlank = has(fieldconf, 'allowBlank')
          ? fieldconf.allowBlank
          : false
        // Optimization: Ensure allowBlank is a function (avoid type check on runtime)
        fieldconf.allowBlank = isFunction(allowBlank)
          ? allowBlank
          : () => allowBlank

        // Default valid method is permissive
        if (!has(fieldconf, 'isValid')) {
          fieldconf.isValid = () => true
        }

        // Require validation as a default except for primary key and timestamp fields
        fieldconf.autoChecked ??= fieldconf.primaryKey || ['createdAt', 'updatedAt'].includes(fieldname) || false
      }

      if (this.primaryKeyFieldname === null) {
        console.warn(new RestinfrontError(`\`primaryKey\` field attribute is missing on ${this.name} model. This can lead to unexpected behavior.`))
      }
    }

    return this
  }

  /*****************************************************************
  * Data formating
  *****************************************************************/

  /**
   * Define the callback for custom collection methods
   */
  static _getCollectionCallback (ref) {
    if (isFunction(ref)) {
      return ref
    } else if (isString(ref)) {
      return (item) => item[this.primaryKeyFieldname] === ref
    } else if (isObject(ref)) {
      return (item) => item[this.primaryKeyFieldname] === ref[this.primaryKeyFieldname]
    }
  }

  /**
   * Build an item based on the schema and filled with default values
   * @param {object} item
   * @returns {object}
   */
  static _buildRawItem (item = {}) {
    const rawItem = {}

    // Build the item with default values
    const primaryKey = item['primaryKey'] || item[this.primaryKeyFieldname] || this.schema[this.primaryKeyFieldname].defaultValue()

    for (const [fieldname, fieldconf] of Object.entries(this.schema)) {
      if (fieldname === this.primaryKeyFieldname) {
        rawItem[fieldname] = primaryKey
      } else if (has(item, fieldname)) {
        rawItem[fieldname] = item[fieldname]
      } else {
        rawItem[fieldname] = fieldconf.defaultValue(primaryKey) // primaryKey argument is necessary for HASONE fieldtype
      }
    }

    return rawItem
  }

  /**
   * Build a validator function for every declared fields
   * @returns {object}
   */
  static _buildValidator () {
    const validator = {}

    // Build the base validator
    for (const [fieldname, fieldconf] of Object.entries(this.schema)) {
      validator[fieldname] = {
        checked: fieldconf.autoChecked,
        isValid: (value, data) => {
          const isBlank = fieldconf.type.isBlank(value)

          return (
            (
              // Blank and allowed
              (isBlank && fieldconf.allowBlank(value, data)) ||
              // Not blank and valid
              (!isBlank && fieldconf.type.isValid(value))
            ) &&
            // Custom valid method
            fieldconf.isValid(value, data)
          )
        }
      }
    }

    return validator
  }

  /**
  * Build instance item
  */
  constructor (data, options = {}) {
    this.$restinfront = {
      fetch: {
        options: null,
        response: null,
        states: {
          progressing: false,
          succeeded: false,
          succeededOnce: false,
          failed: false,
          get: {
            progressing: false,
            succeeded: false,
            failed: false
          }
        }
      }
    }

    // Format an item
    if (isObject(data)) {
      // Add single item specific properties
      this.$restinfront.isNew = options.isNew ?? true
      this.$restinfront.validator = this.constructor._buildValidator()
      this.$restinfront.fetch.save = {
        progressing: false,
        succeeded: false,
        failed: false
      }

      // Build a raw item if it's a new instance
      if (
        this.$restinfront.isNew &&
        this.constructor.schema
      ) {
        data = this.constructor._buildRawItem(data)
      }

      // Format existing fields recursively
      for (const [fieldname, value] of Object.entries(data)) {
        this[fieldname] = has(this.constructor.schema, fieldname)
          ? this.constructor.schema[fieldname].type.beforeBuild(value, options)
          : value
      }
    // Format a collection of items
    } else if (isArray(data)) {
      // Add collection of items specific properties
      this.$restinfront.count = 0

      Object.defineProperty(this.$restinfront, COLLECTION_SYMBOL, {
        value: true,
        writable: false,
        configurable: false,
        enumerable: false
      })

      // Add items to the list
      this._setCollection([])
      for (const item of data) {
        this.add(item, options)
      }

      // Update the count with the grand total
      // Note: must be after .add() processing
      if (has(options, 'count')) {
        this.$restinfront.count = options.count
      }
    }

    return this
  }

  /**
   * Getters
   */

  get isCollection () {
    return COLLECTION_SYMBOL in this.$restinfront
  }

  get isNew () {
    return this.$restinfront.isNew
  }

  get $fetch () {
    return this.$restinfront.fetch.states
  }

  /**
   * Throw an error if the instance is not a collection
   * @returns {void}
   */
  _allowCollection () {
    if (!this.isCollection) {
      throw new RestinfrontError('This function MUST be called by a collection instance')
    }
  }

  /**
   * Throw an error if the instance is not a single item
   * @returns {void}
   */
  _denyCollection () {
    if (this.isCollection) {
      throw new RestinfrontError('This function CANNOT be called by a collection instance')
    }
  }

  /**
   * Set the list of items
   * @param {Array<Model>} newCollection
   * @returns {void}
   */
  _setCollection (newCollection) {
    this[COLLECTION_KEY] = newCollection
  }

  /**
   * Update the current model instance with new data
   * @param {Model} newData
   * @returns {void}
   */
  _mutateData (newData) {
    if (newData.isCollection) {
      // Extend the list or just replace it
      if (this.$restinfront.fetch.options?.extend) {
        newData.forEach(newItem => this.add(newItem))
      } else {
        this._setCollection(newData.items())
      }

      this.$restinfront.count = newData.$restinfront.count
    } else {
      for (const [key, value] of Object.entries(newData)) {
        // Mutate only some keys
        if (key === '$restinfront') {
          this[key].isNew = value.isNew
        // Recursive mutation
        } else if (
          this[key]?.$restinfront &&
          value?.$restinfront
        ) {
          this[key]._mutateData(value)
        // Basic fields
        } else {
          this[key] = value
        }
      }
    }
  }

  /**
   * Format collections and objects to use in back
   * @param {object} options
   * @param {boolean} [options.removeInvalid]
   */
  beforeSerialize (options = {}) {
    if (this.isCollection) {
      return this.map(item => item._beforeSerializeItem(options))
    } else {
      return this._beforeSerializeItem(options)
    }
  }

  /**
   * Format data recursively based on schema definition
   * @param {object} options
   * @param {boolean} [options.removeInvalid]
   */
  _beforeSerializeItem (options = {}) {
    const removeInvalid = options.removeInvalid ?? false

    const newItem = {}

    for (const [fieldname, validator] of Object.entries(this.$restinfront.validator)) {
      const value = this[fieldname]

      if (
        !removeInvalid ||
        (removeInvalid && validator.checked && validator.isValid(value, this))
      ) {
        newItem[fieldname] = this.constructor.schema[fieldname].type.beforeSerialize(value, options)
      }
    }

    return newItem
  }

  /**
   * Convert instance to JSON string
   * @returns {string}
   */
  toJSON () {
    return JSON.stringyfy(this.beforeSerialize())
  }

  /**
   * Clone an instance
   * @returns {Model}
   */
  clone () {
    return new this.constructor(this.beforeSerialize())
  }

  /*****************************************************************
  * Collection methods
  *****************************************************************/

  /**
   * Get the list of items
   * @returns {Array<Model>}
   */
  items () {
    this._allowCollection()
    return this[COLLECTION_KEY]
  }

  /**
   * Proxy for native length
   */
  get length () {
    return this.items().length
  }

  /**
   * Check if there are items in the collection
   */
  get isEmpty () {
    return this.length === 0
  }

  /**
   * The collection can be extended with more items
   */
  get hasMore () {
    return this.length < this.$restinfront.count
  }

  /**
   * Return the last item of the collection
   */
  get last () {
    return this.items()[this.length - 1]
  }

  /**
   * Check if an item is the last of the list
   * @param {Object} ref - item (with the primary key) to check existence
   * @returns {boolean}
   */
  isLast (ref) {
    return this.last[this.constructor.primaryKeyFieldname] === ref[this.constructor.primaryKeyFieldname]
  }

  /**
   * Proxy for native entries
   */
  entries () {
    return this.items().entries()
  }

  /**
   * Proxy for native forEach
   */
  forEach (callback) {
    this.items().forEach(callback)
  }

  /**
   * Proxy for native sort
   */
  sort (callback) {
    return this.items().sort(callback)
  }

  /**
   * Proxy for native some
   */
  some (callback) {
    return this.items().some(callback)
  }

  /**
   * Proxy for native every
   */
  every (callback) {
    return this.items().every(callback)
  }

  /**
   * Proxy for native filter
   */
  filter (callback) {
    return this.items().filter(callback)
  }

  /**
   * Proxy for native map
   */
  map (callback) {
    return this.items().map(callback)
  }

  /**
   * Proxy for native reduce
   */
  reduce (callback, initialValue) {
    return this.items().reduce(callback, initialValue)
  }

  /**
   * Proxy for native find
   * enhancement: find by primaryKey, find by item
   * @param {string|function|object} ref
   * @returns {object|null}
   */
  find (ref) {
    return this.items().find(this.constructor._getCollectionCallback(ref)) || null
  }

  /**
   * Remove all items from the collection
   */
  clear () {
    this.items().splice(0, this.length)
  }

  /**
   * Check if an item exists in the collection
   * enhancement: find by primaryKey, find by item
   * @param {string|function|object} ref
   * @returns {boolean}
   */
  exists (ref) {
    return this.items().some(this.constructor._getCollectionCallback(ref))
  }

  /**
   * Remove the item from the collection based on its primary key
   * enhancement: find by primaryKey, find by item
   * @param {string|function|object} ref
   * @returns {object|null}
   */
  remove (ref) {
    const indexToRemove = this.items().findIndex(this.constructor._getCollectionCallback(ref))

    if (indexToRemove === -1) {
      return null
    }

    this.$restinfront.count = this.$restinfront.count - 1

    return this.items().splice(indexToRemove, 1)
  }

  /**
   * Add a new item to the collection
   * @param {Object} options - optional definition of the item to add
   * @returns {Model}
   */
  add (item = {}, options = {}) {
    const instance = item instanceof this.constructor
      ? item
      : new this.constructor(item, options)

    this.items().push(instance)

    this.$restinfront.count = this.$restinfront.count + 1

    return instance
  }

  /**
   * Remove or add the item from the collection based on its primary key
   * @param {object} item - item (with the primary key) to add or remove
   * @param {function|null} callback
   */
  toggle (item, callback = null) {
    const ref = callback || item

    if (this.exists(ref)) {
      return this.remove(ref)
    } else {
      return this.add(item)
    }
  }

  /*****************************************************************
  * Validation
  *****************************************************************/

  /**
   * Valid a list of fields
   * @param {Array<string>} fieldlist list of fieldname
   * @return {object} errors
   */
  _getValidationErrors (fieldlist) {
    const errors = new Map()

    // Check user defined validation
    for (const fielditem of fieldlist) {
      // Validation for direct fields
      if (isString(fielditem)) {
        const fieldname = fielditem

        if (has(this, fieldname)) {
          this.$restinfront.validator[fieldname].checked = true

          if (this.$restinfront.validator[fieldname].isValid(this[fieldname], this) === false) {
            errors.set(fieldname, { value: this[fieldname], error: 'NOT_VALID' })
          }
        } else {
          errors.set(fieldname, { error: 'NOT_FOUND' })
        }
      // Recursive validation for associations
      } else if (isArray(fielditem)) {
        const fieldname = fielditem[0]
        const fieldlist = fielditem[1]

        if (has(this, fieldname)) {
          this.$restinfront.validator[fieldname].checked = true
          let associationErrors

          if (fieldlist) {
            switch (this.constructor.schema[fieldname].type.association) {
              case 'BelongsTo':
              case 'HasOne':
                if (this[fieldname] !== null) {
                  associationErrors = this[fieldname]._getValidationErrors(fieldlist)
                }
                break
              case 'HasMany':
                // Check if each item of the collection is valid
                associationErrors = this[fieldname]
                  .map(item => item._getValidationErrors(fieldlist))
                  .filter(errors => errors.size > 0)
                break
            }
          } else {
            associationErrors = this._getValidationErrors([fieldname])
          }

          if (
            associationErrors.length > 0 ||
            associationErrors.size > 0
          ) {
            errors.set(fieldname, associationErrors)
          }
        } else {
          errors.set(fieldname, { error: 'NOT_FOUND' })
        }
      } else {
        throw new RestinfrontError('valid: param syntax error')
      }
    }

    return errors
  }

  /**
   * Valid a list of fields
   * @param {Array<string>} fieldlist list of fieldname
   * @return {boolean} result of fields validation
   */
  valid (fieldlist) {
    this._denyCollection()

    if (!isArray(fieldlist)) {
      throw new RestinfrontError('valid: param MUST be an array')
    }

    // Reset save states
    this.$restinfront.fetch.save.progressing = false
    this.$restinfront.fetch.save.succeeded = false
    this.$restinfront.fetch.save.failed = false
    // Proceed to deep validation
    const errors = this._getValidationErrors(fieldlist)
    const isValid = errors.size === 0

    if (!isValid) {
      this.constructor.onValidationError(errors)
    }

    return isValid
  }

  /**
   * Check validation status of a validated field
   * @param {string} fieldname
   * @returns {boolean}
   */
  error (fieldname) {
    return (
      this.$restinfront.validator[fieldname].checked &&
      !this.$restinfront.validator[fieldname].isValid(this[fieldname], this)
    )
  }

  /*****************************************************************
  * HTTP
  *****************************************************************/

  /**
   * Build the request url to pass to the fetch method
   * @param {object} options
   * @param {string} options.pathname
   * @param {object} options.searchParams
   * @returns {string}
   */
  _buildRequestUrl ({ pathname, searchParams }) {
    let requestUrl = joinPaths(this.constructor.baseUrl, this.constructor.endpoint, pathname)

    if (searchParams) {
      requestUrl += `?${
        Object.entries(searchParams)
          .filter(([key, value]) => value !== undefined)
          .map(([key, value]) => {
            if (isDate(value)) {
              value = value.toISOString()
            }
            return `${key}=${encodeURIComponent(value)}`
          })
          .join('&')
      }`
    }

    return requestUrl
  }

  /**
   * Build the request init to pass to the fetch method
   * @param {object} options
   * @param {string} options.method
   * @param {object} options.signal
   * @returns {RequestInit}
   */
  async _buildRequestInit (options = {}) {
    const requestInit = {
      mode: 'cors',
      headers: {
        'Content-Type': 'application/json'
      },
      ...options
    }

    // Set Authorization header for private api
    if (this.constructor.authentication) {
      const token = await this.constructor.authentication()

      if (!token) {
        throw new RestinfrontError(`fetch: \`authentication\` returned an invalid token (${token})`)
      }

      requestInit.headers['Authorization'] = `Bearer ${token}`
    }

    if (['POST', 'PUT', 'PATCH'].includes(requestInit.method)) {
      // Extract validated data only
      requestInit.body = JSON.stringyfy(this.beforeSerialize({ removeInvalid: true }))
    }

    return requestInit
  }

  /**
   * Proceed to the HTTP request
   * @param {object} options
   * @param {GET|POST|PUT|PATCH|DELETE} options.method
   * @returns {Promise<Model>}
   */
  async fetch (options) {
    if (!this.constructor.endpoint) {
      throw new RestinfrontError(`fetch: an \`endpoint\` is required on model \`${this.constructor.name}\` to perform a request`)
    }

    // Reset fetch memoization
    this.$restinfront.fetch.options = options
    this.$restinfront.fetch.response = null

    // Reset fetch states
    this.$restinfront.fetch.states.progressing = true
    this.$restinfront.fetch.states.failed = false
    this.$restinfront.fetch.states.succeeded = false

    if (options.method === 'GET') {
      this.$restinfront.fetch.states.get.progressing = true
      this.$restinfront.fetch.states.get.failed = false
      this.$restinfront.fetch.states.get.succeeded = false
    } else {
      this.$restinfront.fetch.states.save.progressing = true
      this.$restinfront.fetch.states.save.failed = false
      this.$restinfront.fetch.states.save.succeeded = false
    }

    // Build fetch params
    const abortController = new AbortController()
    const requestUrl = this._buildRequestUrl(options)
    const requestInit = await this._buildRequestInit({
      method: options.method,
      signal: abortController.signal
    })
    const abortTimeout = setTimeout(() => {
      abortController.abort()
    }, 20000)

    try {
      // Proceed to api call
      // https://developer.mozilla.org/fr/docs/Web/API/Fetch_API
      this.$restinfront.fetch.response = await fetch(requestUrl, requestInit)

      clearTimeout(abortTimeout)

      // Server side errors raise an exception
      if (!this.$restinfront.fetch.response.ok) {
        throw new RestinfrontError(`fetch: the server responded with an error status code (${this.$restinfront.fetch.response.status})`)
      }

      // Set states to success
      this.$restinfront.fetch.states.succeeded = true
      this.$restinfront.fetch.states.succeededOnce = true
      if (options.method === 'GET') {
        this.$restinfront.fetch.states.get.succeeded = true
      } else {
        this.$restinfront.fetch.states.save.succeeded = true
      }
    } catch (error) {
      this.constructor.onFetchError({ error, response: this.$restinfront.fetch.response })

      // Set states to failure
      this.$restinfront.fetch.states.failed = true
      if (options.method === 'GET') {
        this.$restinfront.fetch.states.get.failed = true
      } else {
        this.$restinfront.fetch.states.save.failed = true
      }
    }

    // Process server data if fetch is successful
    if (this.$restinfront.fetch.states.succeeded) {
      // Get data from server response
      const serverData = await this.$restinfront.fetch.response.json()

      let data = serverData
      const dataOptions = {
        isNew: false
      }

      if (
        has(serverData, this.collectionCountKey) &&
        has(serverData, this.collectionDataKey)
      ) {
        data = serverData[this.constructor.collectionDataKey]
        dataOptions.count = serverData[this.constructor.collectionCountKey]
      }

      const formattedData = new this.constructor(data, dataOptions)
      this._mutateData(formattedData)
    }

    // Progressing done
    if (options.method === 'GET') {
      this.$restinfront.fetch.states.get.progressing = false
    } else {
      this.$restinfront.fetch.states.save.progressing = false
    }
  }

  /**
   * Retrieve a single item or a collection
   * @param {string|object} pathname - Pathname is optional for collection. If it's an object, it's more likely searchParams
   * @param {object} searchParams
   * @returns {void}
   */
  async get (pathname = '', searchParams = {}) {
    if (this.isCollection) {
      // Pathname is optional for collection
      // If pathname is an object, it's more likely searchParams
      if (isObject(pathname)) {
        searchParams = pathname
        pathname = ''
      }

      // Params
      searchParams.limit ??= 20
      searchParams.offset ??= 0

      await this.fetch({
        extend: false,
        method: 'GET',
        pathname,
        searchParams
      })
    } else {
      typecheck({
        pathname: {
          type: 'string',
          required: true
        }
      })

      await this.fetch({
        method: 'GET',
        pathname
      })
    }
  }

  /**
   * Extend a collection with more items
   * @returns {void}
   */
  async getMore () {
    this._allowCollection()

    this.$restinfront.fetch.options.searchParams.offset += this.$restinfront.fetch.options.searchParams.limit

    await this.fetch({
      extend: true,
      method: 'GET',
      pathname: this.$restinfront.fetch.options.pathname,
      searchParams: this.$restinfront.fetch.options.searchParams
    })
  }

  /**
   * Create a new item
   * @param {string} pathname
   * @returns {void}
   */
  async post (pathname = '') {
    this._denyCollection()

    await this.fetch({
      method: 'POST',
      pathname
    })
  }

  /**
   * Update an item
   * @param {string} pathname
   * @returns {void}
   */
  async put (pathname = '') {
    this._denyCollection()

    await this.fetch({
      method: 'PUT',
      pathname: joinPaths(this[this.constructor.primaryKeyFieldname], pathname)
    })
  }

  /**
   * Partial update of an item
   * @param {string} pathname
   * @returns {void}
   */
  async patch (pathname = '') {
    this._denyCollection()

    await this.fetch({
      method: 'PATCH',
      pathname: joinPaths(this[this.constructor.primaryKeyFieldname], pathname)
    })
  }

  /**
   * Create or update the item depends of if it comes from db or not
   * @param {string} pathname
   * @returns {void}
   */
  async save (pathname = '') {
    this._denyCollection()

    if (this.$restinfront.isNew) {
      await this.post(pathname)
    } else {
      await this.put(pathname)
    }
  }
}