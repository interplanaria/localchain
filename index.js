const fs = require('fs')
const path = require('path')
const bsv = require('bsv')
const bpu = require('bpu');
const readline = require('readline')
const Stream = require('stream')
const Tail = require('./tail')
const glob = require("glob")
class Localchain {
  constructor(o) {
    this.path = (o && o.path ? o.path + "/localchain" : process.cwd() + "/localchain")
    this.dats = {};
    this.tails = {};
    this.globalTapePath = this.path + "/tape.txt"
    if (!fs.existsSync(this.path)) {
      fs.mkdirSync(this.path, { recursive: true });
    }
  }
  post (o) {
    let payment = o.payment;
    let type = o.path;
    return new Promise((resolve, reject) => {
      /****************************************************

        BIP270 Format

        Payment {
          merchantData // string. optional.
          transaction // a hex-formatted (and fully-signed and valid) transaction. required.
          refundTo // string. paymail to send a refund to. optional.
          memo // string. optional.
        }

        PaymentACK {
          payment // Payment. required.
          memo // string. optional.
          error // number. optional.
        }

      ****************************************************/
      if (!payment.transaction) {
        reject({ payment: payment, error: "Must include hex-formatted transaction" })
      } else {
        bpu.parse({
          tx: { r: payment.transaction },
          transform: (o, c) => {
            if (c.buf && c.buf.byteLength > 512) {
              o.ls = o.s
              o.lb = o.b
              delete o.s
              delete o.b
            }
            return o
          },
          split: [
            { token: { s: "|" }, },
            { token: { op: 106 }, include: "l" }
          ]
        })
        .then((parsed) => {
          if (parsed) {
            let hash = parsed.tx.h;
            this._post({ hash: hash, payment: payment, path: type }).then((response) => {
              resolve({ payment: payment, memo: response })
            })
          } else {
            reject({ payment: payment, error: "Invalid Transaction" })
          }
        })
        .catch((e) => {
          reject({ payment: payment, error: e })
        })
      }
    })
  }
  async _post (o) {
    /**************************************
    *
    *  o := {
    *    hash: <transaction hash>,
    *    payment: <payment object>,
    *    path: <localchain path>
    *  }
    *
    **************************************/
    // generate hash
    if (o.hash && o.payment && o.path) {
      let poolPath = path.resolve(this.path, o.path)
      let filePath = path.resolve(poolPath, o.hash)
      const fileExists = !!(await fs.promises.stat(poolPath).catch(e => false));
      if (!fileExists) {
        await fs.promises.mkdir(poolPath, { recursive: true });
      }
      await fs.promises.writeFile(filePath, JSON.stringify(o.payment))
      let tapePath = path.resolve(poolPath, "tape.txt")
      let d = Date.now()
      let line = "LOCALCHAIN " + o.hash + " " + d + "\n"
      await fs.promises.appendFile(tapePath, line);

      let globalLine = "LOCALCHAIN " + "/" + o.path + " " + o.hash + " " + d + "\n"
      await fs.promises.appendFile(this.globalTapePath, globalLine)
    } else {
      throw new Error("The post object must contain three attributes: hash, payment, and path") 
    }
  }
  _prune (options) {
    return new Promise((resolve, reject) => {
      // if options.archive is a number, archive up to that number (sort tape-[0-9]+.txt and delete the older ones)
      if (typeof options.archive === 'number') {
        glob("**/tape-*.txt", options, function (er, files) {
          if (files && files.length > 0) {
            files.sort((a, b) => {
              const matchA = /tape-([0-9]+)\.txt/.exec(a)
              const matchB = /tape-([0-9]+)\.txt/.exec(b)
              return (parseInt(matchB[1]) - parseInt(matchA[1]))
            })
            files.slice(options.archive-1).forEach((filename) => {
              fs.unlink(filename, function (err) {
                if (err) throw err
              })
            })
            resolve()
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
  }
  prune (id, options) {
    return new Promise((resolve, reject) => {
      if (id) {
        if (options && options.archive) {
          this._prune(options).then(() => {
            // reset the contents onf tape.txt
            fs.rename(
              this.path + "/" + id + "/tape.txt", 
              this.path + "/" + id + "/tape-" + Date.now() + ".txt", 
              (err) => {
                if (err) {
                  reject(err);
                } else {
                  fs.closeSync(fs.openSync(this.path + "/" + id + "/tape.txt", 'w'));
                  resolve();
                }
              }
            )
          })
        } else {
          // move the tape.txt to "tape-<timestamp>.txt"
          // create a new tape.txt
          fs.writeFile(
            this.path + "/" + id + "/tape.txt", 
            "",
            (err) => {
              if (err) {
                reject(err);
              } else {
                fs.closeSync(fs.openSync(this.path + "/" + id + "/tape.txt", 'w'));
                resolve();
              }
            }
          )
        }
      } else {
        reject(new Error("Must specify the path"))
      }
    })
  }
  on (e, handler) {
    if (e === '*') {
      this._listen({
        path: this.path,
      }, handler)
    } else {
      this._listen({
        path: 'localchain/' + e,
        key: e
      }, handler)
    }
    return this;
  }
  _listen (p, handler) {
    if (!this.tails[p.path]) {
      let tail;
      if (!fs.existsSync(p.path)) {
        fs.mkdirSync(p.path, { recursive: true })
      }
      try {
        if (!fs.existsSync(p.path + "/tape.txt")) {
          fs.closeSync(fs.openSync(p.path + "/tape.txt", 'w'));
        }
        tail = new Tail(p.path + "/tape.txt")
      } catch (e) {
        fs.closeSync(fs.openSync(p.path + "/tape.txt", 'w'));
        tail = new Tail(p.path + "/tape.txt")
      }
      this.tails[p.path] = tail
      tail.on("line", async (data) => {
        let chunks = data.split(" ")
        let type = chunks[0];
        let hash;
        let pp = JSON.parse(JSON.stringify(p))
        if (/^\/.*/.test(chunks[1])) {
          pp.path = p.path + chunks[1]
          pp.key = chunks[1].slice(1)
          hash = chunks[2]
        } else {
          hash = chunks[1]
          pp.path = path.resolve(process.cwd(), p.path)
        }
        this.read(pp, hash, handler)
      });
      tail.on("close", () => {
        console.log("watch closed");
      })
      tail.on("error", (error) => {
        console.log("LOCALCHAIN", 'Tail error', error);
      });
      tail.watch();
    }
  }
  read (p, hash, handler) {
    if (fs.existsSync(p.path + "/" + hash)) {
      fs.readFile(p.path + "/" + hash, "utf8", async (err, content) => {
        let payment = JSON.parse(content);
        let parsed = await bpu.parse({
          tx: { r: payment.transaction },
          transform: (o, c) => {
            if (c.buf && c.buf.byteLength > 512) {
              o.ls = o.s
              o.lb = o.b
              delete o.s
              delete o.b
            }
            return o
          },
          split: [
            { token: { s: "|" }, },
            { token: { op: 106 }, include: "l" }
          ]
        })
        handler({
          path: p.path,
          key: p.key,
          hash: hash,
          payment: JSON.parse(content),
          parsed: parsed
        })
      })
    } else {
      setTimeout(() => {
        this.read(p, hash, handler)      
      }, 1000)
    }
  }
  readPromise(o, txid) {
    return new Promise((resolve, reject) => {
      this.read ({ key: o.key, path: o.path }, txid, (result) => {
        resolve(result)
      })
    })
  }
  tail (o) {
    return new Promise((resolve, reject) => {
      if (o && o.path && o.size) {
        let poolPath;
        if (o.path === '*') {
          poolPath = this.path
        } else {
          poolPath = path.resolve(this.path, o.path)
        }
        let filePath = path.resolve(poolPath, "tape.txt")
        let readStream = fs.createReadStream(filePath);
        let rl = readline.createInterface(readStream, new Stream);
        let cache = []
        rl.on('close', () => {
          // use currentLine here
          let promises = cache.map((c) => {
            return new Promise((_resolve, _reject) => {
              let chunks = c.split(" ");
              let txid = chunks[1];
              let res = this.readPromise({ key: o.path, path: poolPath }, txid)
              _resolve(res)
            })
          })
          Promise.all(promises).then(resolve)
        });
        rl.on('line', (line) => {
          cache.push(line);
          if (cache.length > o.size) {
            cache.shift();
          }
        });
      } else {
        throw new Error("The head query must contain 'path' and 'size' attributes")
      }
    })
  }
  get (o) {
    return new Promise((resolve, reject) => {
      /**************************************
      *
      *  o := {
      *    path: <localchain path>,
      *    hash: <transaction id>
      *  }
      *
      **************************************/
      if (o && o.hash && o.path) {
        let poolPath = path.resolve(this.path, o.path)
        let filePath = path.resolve(poolPath, o.hash)
        try {
          this.read ({ key: o.path, path: poolPath }, o.hash, (result) => {
            resolve(result)
          })
        } catch (e) {
          reject("The file doesn't exist")
        }
      } else {
        throw new Error("The get query must contain 'hash' and 'path' attributes")
      }
    })
  }
}
module.exports = Localchain
