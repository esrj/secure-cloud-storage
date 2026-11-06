/**
 * This file handles ABSE related operations
 */
import * as mcl from 'mcl-wasm'
import { logger } from './Logger'
import GlobalValueManager from './GlobalValueManager'
import assert from 'node:assert'
import io from 'socket.io-client'
import KeyManager from './KeyManager'

// This is used because we only have self-signed certificates.
// Should be removed in real deployment environment
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

class ABSEManager {
  keyManager
  /**
   *
   * @param {KeyManager} keyManager
   */
  constructor(keyManager) {
    this.keyManager = keyManager
  }
  /**
   * Initialize mcl and get public parameter and search key from trusted authority
   */
  async init() {
    try {
      await mcl.init(mcl.BLS12_381)
      await this.getPP()
      await this.getKey()
    } catch (error) {
      logger.error(error)
    }
  }
  /**
   * Tries to get public parameter from trusted authority.
   * @returns public parameters
   */
  async getPP() {
    if (this.pp) return this.pp
    try {
      const fetchUrl = `${GlobalValueManager.trustedAuthority.url}/pp`
      logger.info(`fetching ${fetchUrl} for public parameters.`)
      const response = await fetch(fetchUrl)
      if (!response.ok) {
        logger.warn(`Cannot get public parameter from trusted authority`, { response })
        return null
      }
      logger.info(`Successfully fetched public parameters for ABSE.`)
      const pp = await response.json()
      this.pp = {
        g1: mcl.deserializeHexStrToG1(pp.g1),
        g2: mcl.deserializeHexStrToG2(pp.g2),
        eggalpha: mcl.deserializeHexStrToGT(pp.eggalpha),
        h: mcl.deserializeHexStrToG1(pp.h),
        h_i: new Array(pp.h_i.length),
        U: pp.U
      }
      for (let i = 0; i < pp.h_i.length; i++) {
        this.pp.h_i[i] = mcl.deserializeHexStrToG1(pp.h_i[i])
      }
      return this.pp
    } catch (error) {
      logger.error(error)
      return null
    }
  }
  /**
   * Tries to get search key from trusted authority.
   * @returns {Promise<{SK: {sk1: mcl.G2, sk2: mcl.G2, sk3: mcl.G2, sky: mcl.G2}, y: Array<0|1>}>|undefined} the search key
   */
  async getKey() {
    const globalAttrs = (await this.getPP()).U
    return new Promise((resolve, reject) => {
      // A helper function to deal with error
      function getSearchKeyError(error) {
        if (error.stack) {
          logger.error(error)
        } else {
          logger.error(`Get search key failed because of following error: ${error}`)
        }
        GlobalValueManager.sendNotice('Failed to get search key', 'error')
        socket.close()
        reject(new Error('Cannot get search key.'))
      }
      // Return if already have search key
      if (this.SK && this.y) {
        resolve({ SK: this.SK, y: this.y })
        return
      }
      // Ask for search key
      const socket = io(GlobalValueManager.trustedAuthority.url, {
        rejectUnauthorized: false
      })
      socket.on('connect', () => {
        try {
          logger.info('Asking to get search key...')
          // First ask for authentication
          socket.emit(
            'auth',
            { publicKey: this.keyManager.getPublicKeyString() },
            async ({ errorMsg, cipher, spk }) => {
              if (errorMsg) {
                getSearchKeyError(errorMsg)
                return
              }
              logger.info(`Responding auth to trusted authority.`)
              // respond to auth and get key
              const decryptedValue = await this.keyManager.decrypt(cipher, spk)
              socket.emit('auth-res', { decryptedValue, y: null }, ({ errorMsg, SK, y }) => {
                try {
                  // logger.debug(`trusted authority responded with`, { errorMsg, SK, y })
                  if (errorMsg) {
                    getSearchKeyError(errorMsg)
                    return
                  }
                  if (SK) {
                    this.SK = {
                      sk1: mcl.deserializeHexStrToG2(SK.sk1),
                      sk2: mcl.deserializeHexStrToG2(SK.sk2),
                      sk3: mcl.deserializeHexStrToG2(SK.sk3),
                      sky: mcl.deserializeHexStrToG2(SK.sky)
                    }
                    this.y = y
                    const attrsText = []
                    for (let i = 0; i < y.length - 1; i++) {
                      if (y[i] == 1) attrsText.push(globalAttrs[i])
                    }
                    logger.info(
                      `Successfully get search key with attributes ${attrsText.join(' ')}.`
                    )
                    socket.close()
                    resolve({ SK: this.SK, y: this.y })
                    return
                  } else {
                    getSearchKeyError('Trusted authority respond with empty object')
                    return
                  }
                } catch (error) {
                  getSearchKeyError(error)
                }
              })
            }
          )
        } catch (error) {
          getSearchKeyError(error)
        }
      })
    })
  }

  /**
   * Create an encrypted index for a tag list and attribute list.
   * @param {Array<string>} W the tag list
   * @param {Array<string>} P the attribute list
   * @returns the encrypted file index
   */
  async Enc(W, P) {
    const pp = await this.getPP()
    // Access policy vector x
    const x = new Array(pp.U.length + 1)
    let sum = new mcl.Fr()
    let i
    for (i = 0; i < pp.U.length; i++) {
      const xi = new mcl.Fr()
      if (P.includes(pp.U[i])) {
        xi.setByCSPRNG()
        sum = mcl.add(sum, xi)
      }
      x[i] = xi
    }
    x[i] = mcl.neg(sum)
    sum = new mcl.Fr()
    for (i = 0; i < x.length; i++) {
      sum = mcl.add(sum, x[i])
    }
    assert(sum.isZero())
    const t = new mcl.Fr()
    t.setByCSPRNG()
    const ctStar = mcl.mul(pp.h, t).serializeToHexStr()
    const eggat = mcl.pow(pp.eggalpha, t)
    const ctw = new Array(W.length)
    for (i = 0; i < W.length; i++) {
      const wHash = mcl.hashToFr(W[i])
      const P = mcl.pairing(mcl.mul(pp.g1, wHash), mcl.mul(pp.g2, t))
      ctw[i] = mcl.mul(eggat, P).serializeToHexStr()
    }
    const ct = new Array(pp.h_i.length)
    for (i = 0; i < pp.h_i.length; i++) {
      ct[i] = mcl.add(mcl.mul(pp.h_i[i], t), mcl.mul(pp.g1, x[i])).serializeToHexStr()
    }
    const CTw = { ctStar, ctw, ct }
    return CTw
  }
  /**
   * Create a search trapdoor with the search key and tag list to search for.
   * @param {Array<string>} WPrime the tag list to search for
   * @returns the search trapdoor
   */
  async Trapdoor(WPrime) {
    const { SK, y } = await this.getKey()
    let sum = new mcl.Fr()
    const dPrime = new mcl.Fr()
    dPrime.setInt(WPrime.length)
    for (const w of WPrime) {
      sum = mcl.add(sum, mcl.hashToFr(w))
    }
    const T0 = mcl.mul(SK.sk2, sum)
    const TStar = mcl.add(mcl.mul(SK.sk1, dPrime), T0).serializeToHexStr()
    const T = new Array(y.length)
    const zero = new mcl.Fr()
    zero.setInt(0)
    for (let i = 0; i < y.length; i++) {
      if (y[i] == 1) {
        T[i] = SK.sk3.serializeToHexStr()
      } else {
        T[i] = mcl.mul(SK.sk3, zero).serializeToHexStr()
      }
    }
    const TK = { TStar, T, sky: SK.sky.serializeToHexStr(), dPrime: WPrime.length }
    return TK
  }
  parseTK(serializedTK) {
    const TK = {
      TStar: mcl.deserializeHexStrToG2(serializedTK.TStar),
      T: new Array(serializedTK.T.length),
      sky: mcl.deserializeHexStrToG2(serializedTK.sky),
      dPrime: serializedTK.dPrime
    }
    for (let i = 0; i < serializedTK.T.length; i++) {
      TK.T[i] = mcl.deserializeHexStrToG2(serializedTK.T[i])
    }
    return TK
  }
  /**
   * A testing function to make sure the created TK and file index matches
   * @param {*} serializedTK
   * @param {*} files
   * @returns
   */
  async Search(serializedTK, files) {
    // console.log(serializedTK)
    try {
      const TK = this.parseTK(serializedTK)
      assert(TK.dPrime > 0)
      const result = new Array()
      const dPrimeFr = new mcl.Fr()
      dPrimeFr.setInt(TK.dPrime)
      logger.debug(`Total of ${files.length} files are indexed.`)
      files.forEach(async (file) => {
        const ctStar = mcl.deserializeHexStrToG1(file.ctStar)
        const ctw = file.ctw.map((entry) => mcl.deserializeHexStrToGT(entry))
        // console.log(ctw)
        if (ctw.length < TK.dPrime) return // Keyword to match is larger than keyword set
        const ct = file.ct.map((entry) => mcl.deserializeHexStrToG1(entry))
        // console.log(ct)
        const eCtStarSky = mcl.pairing(ctStar, TK.sky)
        assert(ct.length == TK.T.length)
        assert(ct.length >= 1)
        let prod = mcl.pairing(ct[0], TK.T[0])
        for (let i = 1; i < ct.length; i++) {
          const paired = mcl.pairing(ct[i], TK.T[i])
          prod = mcl.mul(prod, paired)
        }
        const B = mcl.mul(eCtStarSky, prod)
        // console.log(B)
        const D = mcl.div(mcl.pairing(ctStar, TK.TStar), mcl.pow(B, dPrimeFr))
        const backtrack = (currentProd, startIndex, depth) => {
          // Might need to refactor into iteration later
          if (depth == TK.dPrime) {
            // depth start from 0
            // Check if D == D'
            return D.isEqual(currentProd)
          }
          for (let i = startIndex; i < ctw.length - (TK.dPrime - depth) + 1; i++) {
            let newProd
            if (depth == 0) newProd = ctw[i]
            else newProd = mcl.mul(currentProd, ctw[i])
            // console.log(newProd)
            if (backtrack(newProd, i + 1, depth + 1)) return true
          }
        }
        if (backtrack(0, 0, 0)) {
          result.push(file.fileid)
        }
      })
      return result
    } catch (error) {
      logger.error(error)
      return []
    }
  }
}

export default ABSEManager
