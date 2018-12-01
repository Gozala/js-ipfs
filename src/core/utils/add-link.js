'use strict'

const {
  DAGNode,
  DAGLink
} = require('ipld-dag-pb')
const CID = require('cids')
const waterfall = require('async/waterfall')
const DirSharded = require('ipfs-unixfs-importer/src/importer/dir-sharded')
const series = require('async/series')
const log = require('debug')('ipfs:mfs:core:utils:add-link')
const UnixFS = require('ipfs-unixfs')
const Bucket = require('hamt-sharding/src/bucket')
const whilst = require('async/whilst')

const defaultOptions = {
  parent: undefined,
  cid: undefined,
  name: '',
  size: undefined,
  flush: true,
  cidVersion: 0,
  hashAlg: 'sha2-256',
  codec: 'dag-pb',
  shardSplitThreshold: 1000
}

const addLink = (context, options, callback) => {
  options = Object.assign({}, defaultOptions, options)

  if (!options.parentCid) {
    return callback(new Error('No parent CID passed to addLink'))
  }

  if (!CID.isCID(options.parentCid)) {
    return callback(new Error('Invalid CID passed to addLink'))
  }

  if (!options.parent) {
    log('Loading parent node', options.parentCid.toBaseEncodedString())

    return waterfall([
      (cb) => context.ipld.get(options.parentCid, cb),
      (result, cb) => cb(null, result.value),
      (node, cb) => addLink(context, {
        ...options,
        parent: node
      }, cb)
    ], callback)
  }

  if (!options.cid) {
    return callback(new Error('No child cid passed to addLink'))
  }

  if (!options.name) {
    return callback(new Error('No child name passed to addLink'))
  }

  if (!CID.isCID(options.cid)) {
    options.cid = new CID(options.cid)
  }

  if (!options.size && options.size !== 0) {
    return callback(new Error('No child size passed to addLink'))
  }

  const meta = UnixFS.unmarshal(options.parent.data)

  if (meta.type === 'hamt-sharded-directory') {
    log('Adding link to sharded directory')

    return addToShardedDirectory(context, options, callback)
  }

  if (options.parent.links.length >= options.shardSplitThreshold) {
    log('Converting directory to sharded directory')

    return convertToShardedDirectory(context, options, callback)
  }

  log(`Adding ${options.name} to regular directory`)

  addToDirectory(context, options, callback)
}

const convertToShardedDirectory = (context, options, callback) => {
  createShard(context, options.parent.links.map(link => ({
    name: link.name,
    size: link.size,
    multihash: link.cid.buffer
  })).concat({
    name: options.name,
    size: options.size,
    multihash: options.cid.buffer
  }), {}, (err, result) => {
    if (!err) {
      log('Converted directory to sharded directory', result.cid.toBaseEncodedString())
    }

    callback(err, result)
  })
}

const addToDirectory = (context, options, callback) => {
  waterfall([
    (done) => {
      if (options.name) {
        // Remove the old link if necessary
        return DAGNode.rmLink(options.parent, options.name, done)
      }

      done(null, options.parent)
    },
    (parent, done) => {
      // Add the new link to the parent
      DAGNode.addLink(parent, new DAGLink(options.name, options.size, options.cid), done)
    },
    (parent, done) => {
      // Persist the new parent DAGNode
      context.ipld.put(parent, {
        version: options.cidVersion,
        format: options.codec,
        hashAlg: options.hashAlg,
        hashOnly: !options.flush
      }, (error, cid) => done(error, {
        node: parent,
        cid
      }))
    }
  ], callback)
}

const addToShardedDirectory = (context, options, callback) => {
  return waterfall([
    (cb) => generatePath(context, options.name, options.parent, cb),
    ({ rootBucket, path }, cb) => {
      updateShard(context, path, {
        name: options.name,
        cid: options.cid,
        size: options.size
      }, options, (err, result = {}) => cb(err, { rootBucket, ...result }))
    },
    ({ rootBucket, node }, cb) => updateHamtDirectory(context, node.links, rootBucket, options, cb)
  ], callback)
}

const updateShard = (context, positions, child, options, callback) => {
  const {
    bucket,
    prefix,
    node
  } = positions.pop()

  const link = node.links
    .find(link => link.name.substring(0, 2) === prefix && link.name !== `${prefix}${child.name}`)

  return waterfall([
    (cb) => {
      if (link && link.name.length > 2) {
        log(`Converting existing file ${link.name} into sub-shard for ${child.name}`)

        return waterfall([
          (done) => createShard(context, [{
            name: link.name.substring(2),
            size: link.size,
            multihash: link.cid.buffer
          }, {
            name: child.name,
            size: child.size,
            multihash: child.cid.buffer
          }], {}, done),
          ({ node: { links: [ shard ] } }, done) => {
            return context.ipld.get(shard.cid, (err, result) => {
              done(err, { cid: shard.cid, node: result && result.value })
            })
          },
          (result, cb) => updateShardParent(context, bucket, node, link.name, result.node, result.cid, prefix, options, cb)
        ], cb)
      }

      if (link && link.name.length === 2) {
        log(`Descending into sub-shard ${link.name} for ${child.name}`)

        return waterfall([
          (cb) => updateShard(context, positions, child, options, cb),
          (result, cb) => updateShardParent(context, bucket, node, link.name, result.node, result.cid, prefix, options, cb)
        ], cb)
      }

      log(`Adding or replacing file`, prefix + child.name)
      updateShardParent(context, bucket, node, prefix + child.name, child, child.cid, prefix + child.name, options, cb)
    }
  ], callback)
}

const createShard = (context, contents, options, callback) => {
  const shard = new DirSharded({
    root: true,
    dir: true,
    parent: null,
    parentKey: null,
    path: '',
    dirty: true,
    flat: false,

    ...options
  })

  const operations = contents.map(contents => {
    return (cb) => {
      shard.put(contents.name, {
        size: contents.size,
        multihash: contents.multihash
      }, cb)
    }
  })

  return series(
    operations,
    (err) => {
      if (err) {
        return callback(err)
      }

      shard.flush('', context.ipld, null, callback)
    }
  )
}

const updateShardParent = (context, bucket, parent, name, node, cid, prefix, options, callback) => {
  waterfall([
    (done) => DAGNode.rmLink(parent, name, done),
    (parent, done) => DAGNode.addLink(parent, new DAGLink(prefix, node.size, cid), done),
    (parent, done) => updateHamtDirectory(context, parent.links, bucket, options, done)
  ], callback)
}

const updateHamtDirectory = (context, links, bucket, options, callback) => {
  // update parent with new bit field
  waterfall([
    (cb) => {
      const data = Buffer.from(bucket._children.bitField().reverse())
      const dir = new UnixFS('hamt-sharded-directory', data)
      dir.fanout = bucket.tableSize()
      dir.hashType = DirSharded.hashFn.code

      DAGNode.create(dir.marshal(), links, cb)
    },
    (parent, done) => {
      // Persist the new parent DAGNode
      context.ipld.put(parent, {
        version: options.cidVersion,
        format: options.codec,
        hashAlg: options.hashAlg,
        hashOnly: !options.flush
      }, (error, cid) => done(error, {
        node: parent,
        cid
      }))
    }
  ], callback)
}

const recreateHamtLevel = (links, rootBucket, parentBucket, positionAtParent, callback) => {
  // recreate this level of the HAMT
  const bucket = new Bucket({
    hashFn: DirSharded.hashFn,
    hash: parentBucket ? parentBucket._options.hash : undefined
  }, parentBucket, positionAtParent)

  if (parentBucket) {
    parentBucket._putObjectAt(positionAtParent, bucket)
  }

  addLinksToHamtBucket(links, bucket, rootBucket, callback)
}

const addLinksToHamtBucket = (links, bucket, rootBucket, callback) => {
  Promise.all(
    links.map(link => {
      if (link.name.length === 2) {
        const pos = parseInt(link.name, 16)

        bucket._putObjectAt(pos, new Bucket({
          hashFn: DirSharded.hashFn
        }, bucket, pos))

        return Promise.resolve()
      }

      return (rootBucket || bucket).put(link.name.substring(2), true)
    })
  )
    .catch(err => {
      callback(err)
      callback = null
    })
    .then(() => callback && callback(null, bucket))
}

const toPrefix = (position) => {
  return position
    .toString('16')
    .toUpperCase()
    .padStart(2, '0')
    .substring(0, 2)
}

const generatePath = (context, fileName, rootNode, callback) => {
  // start at the root bucket and descend, loading nodes as we go
  recreateHamtLevel(rootNode.links, null, null, null, async (err, rootBucket) => {
    if (err) {
      return callback(err)
    }

    const position = await rootBucket._findNewBucketAndPos(fileName)

    // the path to the root bucket
    let path = [{
      bucket: position.bucket,
      prefix: toPrefix(position.pos)
    }]
    let currentBucket = position.bucket

    while (currentBucket !== rootBucket) {
      path.push({
        bucket: currentBucket,
        prefix: toPrefix(currentBucket._posAtParent)
      })

      currentBucket = currentBucket._parent
    }

    path[path.length - 1].node = rootNode

    let index = path.length

    // load DAGNode for each path segment
    whilst(
      () => index > 0,
      (next) => {
        index--

        const segment = path[index]

        // find prefix in links
        const link = segment.node.links
          .filter(link => link.name.substring(0, 2) === segment.prefix)
          .pop()

        if (!link) {
          // reached bottom of tree, file will be added to the current bucket
          log(`Link ${segment.prefix}${fileName} will be added`)
          return next(null, path)
        }

        if (link.name === `${segment.prefix}${fileName}`) {
          log(`Link ${segment.prefix}${fileName} will be replaced`)
          // file already existed, file will be added to the current bucket
          return next(null, path)
        }

        // found subshard
        log(`Found subshard ${segment.prefix}`)
        context.ipld.get(link.cid, (err, result) => {
          if (err) {
            return next(err)
          }

          // subshard hasn't been loaded, descend to the next level of the HAMT
          if (!path[index - 1]) {
            log(`Loaded new subshard ${segment.prefix}`)
            const node = result.value

            return recreateHamtLevel(node.links, rootBucket, segment.bucket, parseInt(segment.prefix, 16), async (err, bucket) => {
              if (err) {
                return next(err)
              }

              const position = await rootBucket._findNewBucketAndPos(fileName)

              index++
              path.unshift({
                bucket: position.bucket,
                prefix: toPrefix(position.pos),
                node: node
              })

              next()
            })
          }

          const nextSegment = path[index - 1]

          // add intermediate links to bucket
          addLinksToHamtBucket(result.value.links, nextSegment.bucket, rootBucket, (error) => {
            nextSegment.node = result.value

            next(error)
          })
        })
      },
      async (err, path) => {
        await rootBucket.put(fileName, true)

        callback(err, { rootBucket, path })
      }
    )
  })
}

module.exports = addLink
