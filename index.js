const Buffer = require('safe-buffer').Buffer
const EventEmitter = require('events').EventEmitter
const PeerInfo = require('peer-info')
const PeerId = require('peer-id')
const pull = require('pull-stream')
const Pushable = require('pull-pushable')
const Reader = require('pull-reader')
const debug = require('debug')
const log = debug('discovery:gossip')
debug.enable('discovery:gossip')

const PROTO = '/discovery/gossip/0.0.0'

module.exports = class handlePeers extends EventEmitter {
  /**
   * @param {Object} node - an instace of [libp2p](https://github.com/libp2p/js-libp2p)
   * @param {Number} targetNumberOfPeers - the max number of peers to add to the peer book
   */
  constructor (targetNumberOfPeers) {
    super()
    this.targetNumberOfPeers = targetNumberOfPeers
  }

  attach (node) {
    this.node = node
  }
  /**
   * starts the gossip process
   */
  start (cb) {
    const node = this.node
    node.handle(PROTO, (proto, conn) => {
      const p = Pushable()
      pull(p, conn)

      let peers = peerBookToJson(node.peerBook)

      if (Object.keys(peers).length === 0) {
        p.push(Buffer.from([0]))
      } else {
        peers = Buffer.from(JSON.stringify(peers))
        p.push(Buffer.from([peers.length]))
        p.push(peers)
      }
      p.end()
    })
    this.peerDiscovery(this.targetNumberOfPeers)

    cb()
  }
  /**
   * stop discovery
   */
  stop () {
    console.log("stop called")
    this.node.unhandle(PROTO)
    this.node.removeListener('peer:connect', this._onConnection)
  }

  peerDiscovery (targetNumberOfPeers) {
    const newPeers = this.node.peerBook.getAllArray()
    this._peerDiscovery(this.node, targetNumberOfPeers, newPeers)
    this.node.on('peer:connect', this._onConnection.bind(this))
  }

  _onConnection (peer) {
    log('connected peer, restarting discovery')
    try {
      const info = this.node.peerBook.get(peer)
      if (!info._askedForPeers) {
        throw new Error()
      }
    } catch (e) {
      this._peerDiscovery(this.node, this.targetNumberOfPeers, [peer])
    }
  }

  _peerDiscovery (node, targetNumberOfPeers, newPeers) {
    let knownPeers = node.peerBook.getAllArray()

    // If we want more peers, and more peers exist
    if (knownPeers.length < targetNumberOfPeers && newPeers.length !== 0) {
      newPeers.forEach(peer => {
        console.log("peer:", peer.id._idB58String)
        // Check if attempting to discover self, break if so.
        if (node.peerInfo.id._idB58String === peer.id._idB58String) {
          node.peerBook.remove(peer)
          return
        }

        peer._askedForPeers = true
        console.log("about to dial...")
        console.log("node isStarted...", node.isStarted())

        if (!node.isStarted()) {
          // Node is not started yet, break
          return
        }

        node.dial(peer, PROTO, async (err, conn) => {
          console.log("inside dial...", err)
          if (err) {
            // Remove peers that we cannot connect to
            node.peerBook.remove(peer)
          } else {
            try {
              console.log("before readPeers")
              console.log("me:", node.peerInfo.id._idB58String)
              console.log("peer:", peer.id._idB58String)
              const peers = await readPeers(node, conn)
              console.log("before filterPeers")
              const newPeers = await this.filterPeers(node, peers)
              console.log("before _peerDiscovery")
              return this._peerDiscovery(node, targetNumberOfPeers, newPeers)

              // If any errors: assume malicious, remove from our list
              // TODO: extend peerbook to track reputation...
            } catch (e) {
              console.log("caught..", e)
              // Remove peers that are potentially malicous
              node.hangUp(peer, () => {
                console.log("hanging up...")
                node.peerBook.remove(peer)
                node.emit('error', peer)
              })
            }
          }
        })
      })
    }
  }

  filterPeers (node, peers) {
    const ids = Object.keys(peers)
    const newPeers = []
    ids.forEach(async id => {
      try {
        node.peerBook.get(id)
        log('already have peer ', id)
      } catch (e) {
        const peerId = PeerId.createFromB58String(id)
        const peerInfo = new PeerInfo(peerId)
        const addresses = peers[id]
        addresses.forEach(ad => {
          peerInfo.multiaddrs.add(`${ad}/ipfs/${id}`)
        })
        node.peerBook.put(peerInfo)
        newPeers.push(peerInfo)
        this.emit('peer', peerInfo)
      }
    })
    return newPeers
  }
}

function readPeers (node, conn) {
  console.log('inside readpeers')
  const reader = Reader()
  console.log("before pull")
  pull(conn, reader)
  console.log("before promise")
  return new Promise((resolve, reject) => {
    console.log("inside promise")
    reader.read(1, (err, len) => {
      console.log("inside .read", err, len)
      if (err) {
        reject(err)
      } else if (len[0] !== 0) {
        console.log("inside else if")
        reader.read(len[0], (err, data) => {
          console.log("inside 2nd read", err, data)
          if (err) {
            console.log("reject err", err)
            reject(err)
          } else {
            data = data.toString()
            const peers = JSON.parse(data)
            reader.abort()
            resolve(peers)
          }
        })
      } else {
        reader.abort()
        resolve({})
      }
    })
  })
}

function peerBookToJson (peerBook) {
  let peers = {}
  peerBook.getAllArray().forEach(pi => {
    peers[pi.id.toB58String()] = pi.multiaddrs.toArray().map(add => {
      return add.toString().split('/').slice(0, -2).join('/')
    })
  })
  return peers
}
