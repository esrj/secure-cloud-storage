/**
 * This file handles operations for attributed based searchable encryption.
 */
import * as mcl from "mcl-wasm";
import { logger } from "./Logger.js";
import {
  insertParams,
  getParams,
  insertArrayParams,
  getArrayParams,
  getAttributeArrayParams,
} from "./Database.js";

export class TrustedAuthority {
  msk = {
    alpha: undefined,
    beta: undefined,
    s: undefined,
  };
  _pp = {
    g1: undefined,
    g2: undefined,
    eggalpha: undefined,
    h: undefined,
    h_i: undefined,
    U: undefined,
  };
  _serializedPP = {
    g1: undefined,
    g2: undefined,
    eggalpha: undefined,
    h: undefined,
    h_i: undefined,
    U: undefined,
  };

  /**
   * Initialize mcl and setup parameters
   */
  async init() {
    await mcl.init(mcl.BLS12_381);
    if (!this.retrieveParams()) {
      this.SetUp();
      this.storeParams();
    }
  }

  // get pp() {
  //   this.updateGlobalAttribute();
  //   return this._pp;
  // }

  /**
   * Serialized public parameters
   */
  get serializedPP() {
    this.updateGlobalAttribute();
    return this._serializedPP;
  }

  get arrayParamLength() {
    return this.msk.s.length;
  }

  /**
   * Retrieve parameters from database and store in variables
   * @returns Whether retrieval is success
   */
  retrieveParams() {
    const params = getParams.get();
    if (!params) return false;
    const arrayParams = getArrayParams.all();
    const U = new Array(arrayParams.length - 1);
    const s = new Array(arrayParams.length);
    const h_i = new Array(arrayParams.length);
    const serializedH_i = new Array(arrayParams.length);
    for (const array_param of arrayParams) {
      s[array_param.id] = mcl.deserializeHexStrToFr(array_param.s);
      h_i[array_param.id] = mcl.deserializeHexStrToG1(array_param.h_i);
      serializedH_i[array_param.id] = array_param.h_i;
      if (array_param.u != "EOF") U[array_param.id] = array_param.u;
    }
    this.msk = {
      alpha: mcl.deserializeHexStrToFr(params.alpha),
      beta: mcl.deserializeHexStrToFr(params.beta),
      s,
    };
    this._pp = {
      g1: mcl.deserializeHexStrToG1(params.g1),
      g2: mcl.deserializeHexStrToG2(params.g2),
      eggalpha: mcl.deserializeHexStrToGT(params.eggalpha),
      h: mcl.deserializeHexStrToG1(params.h),
      h_i,
      U,
    };
    this._serializedPP = {
      g1: params.g1,
      g2: params.g2,
      eggalpha: params.eggalpha,
      h: params.h,
      h_i: serializedH_i,
      U,
    };
    return true;
  }
  /**
   * Store parameters into database
   */
  storeParams() {
    this._serializedPP = {
      g1: this._pp.g1.serializeToHexStr(),
      g2: this._pp.g2.serializeToHexStr(),
      eggalpha: this._pp.eggalpha.serializeToHexStr(),
      h: this._pp.h.serializeToHexStr(),
      h_i: new Array(this.arrayParamLength),
      U: this._pp.U,
    };
    insertParams.run(
      this.msk.alpha.serializeToHexStr(),
      this.msk.beta.serializeToHexStr(),
      this._pp.g1.serializeToHexStr(),
      this._pp.g2.serializeToHexStr(),
      this._pp.eggalpha.serializeToHexStr(),
      this._pp.h.serializeToHexStr()
    );
    // add serializedPP
    let i;
    for (i = 0; i < this._pp.U.length; i++) {
      this._serializedPP.h_i[i] = this._pp.h_i[i].serializeToHexStr();
      insertArrayParams.run(
        i,
        this._pp.U[i],
        this.msk.s[i].serializeToHexStr(),
        this._serializedPP.h_i[i]
      );
    }
    this._serializedPP.h_i[i] = this._pp.h_i[i].serializeToHexStr();
    insertArrayParams.run(
      i,
      "EOF",
      this.msk.s[i].serializeToHexStr(),
      this._serializedPP.h_i[i]
    );
    logger.info(`Parameters stored in database.`);
  }

  /**
   * Update global attributes from database (as CLI could modify it)
   */
  updateGlobalAttribute() {
    const attrParams = getAttributeArrayParams.all();
    for (const param of attrParams) {
      if (param.u != "EOF") {
        this._pp.U[param.id] = param.u;
        this._serializedPP.U[param.id] = param.u;
      }
    }
  }

  /**
   * Setup parameters
   */
  SetUp() {
    logger.info(`This is the first time for the server to run. Doing setup.`);
    const attr_num = process.env.ATTR_NUM || 32;
    const U = ["機密", "極機密", "絕對機密"].concat(
      ...new Array(Math.max(attr_num - 3, 0)).fill("None")
    );
    // console.log(U.length);
    // Follow convention from https://github.com/zcash/librustzcash/blob/6e0364cd42a2b3d2b958a54771ef51a8db79dd29/pairing/src/bls12_381/README.md#generators
    const g1 = new mcl.G1();
    g1.setStr(
      "1 3685416753713387016781088315183077757961620795782546409894578378688607592378376318836054947676345821548104185464507 1339506544944476473020471379941921221584933875938349620426543736416511423956333506472724655353366534992391756441569"
    );

    const g2 = new mcl.G2();
    g2.setStr(
      "1 352701069587466618187139116011060144890029952792775240219908644239793785735715026873347600343865175952761926303160 3059144344244213709971259814753781636986470325476647558659373206291635324768958432433509563104347017837885763365758 1985150602287291935568054521177171638300868978215655730859378665066344726373823718423869104263333984641494340347905 927553665492332455747201965776037880757740193453592970025027978793976877002675564980949289727957565575433344219582"
    );
    // console.log(P)
    // console.log(Q)
    const alpha = new mcl.Fr();
    const beta = new mcl.Fr();
    alpha.setByCSPRNG();
    beta.setByCSPRNG();
    const s = new Array(U.length + 1);
    const h_i = new Array(s.length);
    for (let i = 0; i < s.length; i++) {
      const si = new mcl.Fr();
      si.setByCSPRNG();
      s[i] = si;
      const hi = mcl.mul(g1, si);
      h_i[i] = hi;
    }
    const h = mcl.mul(g1, beta);
    const eggalpha = mcl.pow(mcl.pairing(g1, g2), alpha);
    const msk = { alpha, beta, s };
    const pp = { g1, g2, eggalpha, h, h_i, U };
    this.msk = msk;
    this._pp = pp;
  }

  /**
   * Compute a search key for an attribute vector.
   * @param {[1|0]} y the attribute vector
   * @returns search keys
   */
  KeyGen(y) {
    // this.updateGlobalAttribute();
    // Attribute vector y
    // const y = new Array(this.msk.s.length);
    // let i;
    // for (i = 0; i < this._pp.U.length; i++) {
    //   y[i] = R.includes(this._pp.U[i]) ? 1 : 0;
    // }
    // y[i] = 1;
    // console.log(y);
    const theta = new mcl.Fr();
    const mu = new mcl.Fr();
    theta.setByCSPRNG();
    mu.setByCSPRNG();
    const sk1 = mcl
      .mul(this._pp.g2, mcl.div(mcl.add(this.msk.alpha, mu), this.msk.beta))
      .serializeToHexStr();
    const sk2 = mcl
      .mul(this._pp.g2, mcl.inv(this.msk.beta))
      .serializeToHexStr();
    const sk3 = mcl.mul(this._pp.g2, theta).serializeToHexStr();
    let innerProd = new mcl.Fr(); // will be zero
    // assert.equal(this.msk.s.length, y.length);
    for (let i = 0; i < this.msk.s.length; i++) {
      if (y[i] == 1) {
        innerProd = mcl.add(innerProd, this.msk.s[i]);
      }
    }
    const sky = mcl
      .mul(
        this._pp.g2,
        mcl.div(mcl.sub(mu, mcl.mul(theta, innerProd)), this.msk.beta)
      )
      .serializeToHexStr();
    const SK = { sk1, sk2, sk3, sky };
    return SK;
  }
}
