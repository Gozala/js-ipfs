/* eslint max-nested-callbacks: ["error", 8] */
'use strict'

const { parallelMap } = require('streaming-iterables')
const CID = require('cids')
const { resolvePath } = require('../../utils')
const PinManager = require('./pin-manager')
const { PinTypes } = PinManager
const { withTimeoutOption } = require('../../utils')

const PIN_LS_CONCURRENCY = 8

/**
 * @typedef {import('../index').DAG} DAG
 * @typedef {import('./pin-manager').PinType} PinType
 */
/**
 * @typedef {Object} PinEntry
 * @property {string} type
 * @property {CID} cid
 *
 * @param {Object} config
 * @param {PinManager} config.pinManager
 * @param {DAG} config.dag
 * @returns {LS}
 */
module.exports = ({ pinManager, dag }) => {
  /**
   * @typedef {Object} Options
   * @property {PinType} [type]
   * @property {boolean} [preload]
   *
   * @callback LS
   * @param {string[]|string} [paths]
   * @param {Options} [options]
   * @returns {AsyncIterator<PinEntry>}
   *
   * @type {LS}
   */
  async function * ls (paths, options) {
    options = options || {}

    let type = PinTypes.all

    if (paths && !Array.isArray(paths) && !CID.isCID(paths) && typeof paths !== 'string') {
      options = paths
      // @ts-ignore - type is string|string[] and null is not allowed.
      paths = null
    }

    if (options.type) {
      type = options.type
      if (typeof options.type === 'string') {
        type = /** @type {PinType} */(options.type.toLowerCase())
      }
      const err = PinManager.checkPinType(type)
      if (err) {
        throw err
      }
    }

    if (paths) {
      /** @type {string[]} */
      paths = Array.isArray(paths) ? paths : [paths]

      // check the pinned state of specific hashes
      const cids = await resolvePath(dag, paths)

      yield * parallelMap(PIN_LS_CONCURRENCY, async cid => {
        const { reason, pinned } = await pinManager.isPinnedWithType(cid, type)

        if (!pinned) {
          throw new Error(`path '${paths[cids.indexOf(cid)]}' is not pinned`)
        }

        if (reason === PinTypes.direct || reason === PinTypes.recursive) {
          return { cid, type: reason }
        }

        return { cid, type: `${PinTypes.indirect} through ${reason}` }
      }, cids)

      return
    }

    // show all pinned items of type
    /** @type {PinEntry[]} */
    let pins = []

    if (type === PinTypes.direct || type === PinTypes.all) {
      pins = pins.concat(
        Array.from(pinManager.directPins).map(cid => ({
          type: PinTypes.direct,
          cid: new CID(cid)
        }))
      )
    }

    if (type === PinTypes.recursive || type === PinTypes.all) {
      pins = pins.concat(
        Array.from(pinManager.recursivePins).map(cid => ({
          type: PinTypes.recursive,
          cid: new CID(cid)
        }))
      )
    }

    if (type === PinTypes.indirect || type === PinTypes.all) {
      const indirects = await pinManager.getIndirectKeys(options)

      pins = pins
        // if something is pinned both directly and indirectly,
        // report the indirect entry
        .filter(({ cid }) => !indirects.includes(cid.toString()) || !pinManager.directPins.has(cid.toString()))
        .concat(indirects.map(cid => ({ type: PinTypes.indirect, cid: new CID(cid) })))
    }

    // FIXME: https://github.com/ipfs/js-ipfs/issues/2244
    yield * pins
  }

  return withTimeoutOption(ls)
}
