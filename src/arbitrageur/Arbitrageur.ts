import { min } from "@perp/common/build/lib/bn"
import { EthService } from "@perp/common/build/lib/eth/EthService"
import { sleep } from "@perp/common/build/lib/helper"
import { Log } from "@perp/common/build/lib/loggers"
import { BotService } from "@perp/common/build/lib/perp/BotService"
import { AmountType, Side } from "@perp/common/build/lib/perp/PerpService"
import { CollateralManager, IClearingHouse } from "@perp/common/build/types/curie"
import Big from "big.js"
import { ethers } from "ethers"
import { max, padEnd, update } from "lodash"
import { Service } from "typedi"
import config from "../configs/config.json"
require('dotenv').config();

// typedefs
type BaseTokenAddr = string
type EthersWallet = ethers.Wallet
type closeFuncType = (arg1: EthersWallet, arg2: BaseTokenAddr) => Promise<void>

const BEAR = Side.SHORT
const BULL = Side.LONG
//const ZBRA = (Side.NEUTRAL)  //TODO
//TESTING: block SOLShort: 65131100, 55746888
//TODO.REFACT put on utility function. Templetize
const TP_MIN_MR    = 0.12  // 8.33x
const TP_MR_DEC_SZ = 0.02
const TP_MAX_MR    = 0.50 
const TP_MR_INC_SZ = 0.02  // OJO you INC onStopLoss 5x

interface Result<T> {
    error?: Error;
    positive: T | null;
  }

// below not used remove
const OP_USDC_ADDR = '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'

type Wallet = ethers.Wallet
function transformValues(map: Map<string, string>, 
                        func: (n:string) => Wallet): Map<string, Wallet> {
    const result = new Map<string, Wallet>();
    map.forEach((value, key) => { result.set(key, func(value));});
    return result;
  }
  // NOTE: START_COLLATERAL, collateral and peakcollateral: collat is the 'real collat' init to START_COLLATERAL and update on
  // scale down/up. virtual collateral is the 'peak' unrealized collateral

interface Market {
    wallet: Wallet
    side: Side
    name: string
    active: boolean
    baseToken: string
    poolAddr: string
    minReturn: number
    maxReturn: number
    minMarginRatio: number
    maxMarginRatio: number
    basisCollateral: number
    startCollateral: number
    twin: string
//    peakCollateral: number
    resetLeverage: number
    leverage: number
    resetNeeded:boolean
    resetSize: number
    cummulativeLoss: number
    notionalBasis: number
    maxPnl: number
// TODO.RMV
orderAmount: Big

}

const DUST_USD_SIZE = Big(100)

@Service()
export class Arbitrageur extends BotService {
    readonly log = Log.getLogger(Arbitrageur.name)

    //private wallet!: ethers.Wallet
    // pkMap<market,pk>
    //private pkMap = new Map<string,string>([...Object.entries(pkconfig.PK_MAP)])
    private resetMap = new Map<string, boolean>()
    private pkMap = new Map<string, string>()
    private marketMap: { [key: string]: Market } = {}
    private readonly arbitrageMaxGasFeeEth = Big(config.ARBITRAGE_MAX_GAS_FEE_ETH)
    private holosSide: Side | null = null
    private prevHolsSide: Side | null = null
    //private closedHolos: string[] = []

//----------------------------------------------------------------------------------------
// DBG/ manual
// block: 888, vPERP
//----------------------------------------------------------------------------------------
async dbg_openclose() {
    let mkt = 'vPERP'
    let btoken = "0x9482AaFdCed6b899626f465e1FA0Cf1B1418d797"
    let side = Side.SHORT
    let usdAmount = 50

    let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(mkt)!)
    try {
        await this.openPosition(wlt!, btoken ,side,AmountType.QUOTE,Big(usdAmount),undefined,undefined,undefined)
    }
    catch (e: any) {
        console.error(`ERROR: FAILED OPEN. Rotating endpoint: ${e.toString()}`)
    }
}

async dbg_get_uret() {
    // OJO. dont wast time testing what u know already works. closing and reopening
    // works that is not changing only logi to compute ure. the other changes
    // initialize initialCollatera are trivial
    let mkt = 'vPERP'
    let perpBaseToken = "0x9482AaFdCed6b899626f465e1FA0Cf1B1418d797"
    let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(mkt)!)
    let test =  await this.perpService.getTotalPositionSize(wlt.address, perpBaseToken)
    let vault = await this.perpService.createVault()

    const initalCollateral = this.marketMap[mkt].collateral
    const currCollateral = (await vault.getBalanceByToken(wlt.address, OP_USDC_ADDR)) / 10**6
    const upnl =  (await this.perpService.getOwedAndUnrealizedPnl(wlt.address)).unrealizedPnl

    //check return value makes sense
    let uret = 1 + (currCollateral + upnl.toNumber() - initalCollateral)/initalCollateral
    
     //regardless if stoploss or scale, need to 1.close and 2.open 
     // that is not changing. no need to retest  
    console.log(uret)
}

    async setup(): Promise<void> {
        this.log.jinfo({
            event: "SetupNoLo",
        })
        //note. ignore entry on provider url. using vSYMB[_SHORT]
       // Print the names and values of all the variables that match the pattern 'v[A-Z]{3,}'
        const pattern = /^v[A-Z]{3,}/  
        let vk = Object.entries(process.env).filter(([k])=> pattern.test(k))

        for (const [key, value] of vk) {
            this.pkMap.set(key, value!);
          }
          
        // initilize pkMap
        //let wlts = this.pkMap.forEach((v,k) => this.ethService.privateKeyToWallet(v))
          let wlts = transformValues(this.pkMap, v => this.ethService.privateKeyToWallet(v))
        // needed by BotService.retrySendTx
        await this.createNonceMutex([...wlts.values()])
        await this.createMarketMap()

        /*this.log.jinfo({
            event: "Arbitrageur",
            params: {
                address: this.wallet.address,
                //TODO.STK display nextnonce for all walets: nextNonce: this.addrNonceMutexMap[this.walletMap[].address].nextNonce,
                //nextNonce: this.addrNonceMutexMap[this.wallet.address].nextNonce,
             }, })*/
    }

   async createMarketMap() {
        const poolMap: { [keys: string]: any } = {}
        for (const pool of this.perpService.metadata.pools) {
            poolMap[pool.baseSymbol] = pool
        }
        for (const [marketName, market] of Object.entries(config.MARKET_MAP)) {
            if (!market.IS_ENABLED) {
                continue
            }
            const pool = poolMap[marketName.split('_')[0]]
            
            this.marketMap[marketName] = {
                name: marketName,
                active: true,
                wallet: this.ethService.privateKeyToWallet(this.pkMap.get(marketName)!),
                side: marketName.endsWith("SHORT") ? Side.SHORT : Side.LONG,
                baseToken: pool.baseAddress,
                poolAddr: pool.address,
                //TODO.RMV order amount
                orderAmount: Big(666),
                minReturn: market.MIN_RETURN,
                maxReturn: market.MAX_RETURN,
                minMarginRatio: market.MIN_MARGIN_RATIO,
                maxMarginRatio: market.MAX_MARGIN_RATIO,
                basisCollateral: market.START_COLLATERAL,
                startCollateral: market.START_COLLATERAL,
//              peakCollateral: market.START_COLLATERAL,
                resetLeverage: market.RESET_LEVERAGE,
                leverage: market.RESET_LEVERAGE,
                cummulativeLoss: 0,
                maxPnl: 0,
                notionalBasis: config.TP_START_CAP*market.RESET_LEVERAGE,
                //TODO.rmv
                resetNeeded: false,
                resetSize:0,
                twin: marketName.endsWith("SHORT") ? marketName.split("_")[0] : marketName + "_SHORT"
            }
        }
    }

    async start(): Promise<void> {
        this.ethService.enableEndpointRotation()
        //const balance = await this.perpService.getUSDCBalance(this.wallet.address)
        //this.log.jinfo({ event: "CheckUSDCBalance", params: { balance: +balance } })
        /*
        if (balance.gt(0)) {
            await this.approve(this.wallet, balance)
            await this.deposit(this.wallet, balance)
        }
        */
       // OJO. BOOKMARK. after done testin. COMMENT out AND uncomment this.arbitrageRoutine()
        //this.dbg_get_uret()
        // UNCOMMENT ME ABOVE to debug
        // WAIT FOR setup to finish

        this.arbitrageRoutine()
    }


    async arbitrageRoutine() {
        while (true) {
            //TODO.STK turn on heart beat below
            //this.markRoutineAlive("ArbitrageRoutine")
            await Promise.all(
                Object.values(this.marketMap).map(async market => {
                    try {
                        await this.arbitrage(market)
                    } catch (err: any) {
                        await this.jerror({ event: "ArbitrageError", params: { err } })
                    }
                }),
            )
            await sleep(config.PRICE_CHECK_INTERVAL_SEC * 1000)
        }
    }

    
 // TODO move to butil file
 async open(wlt: ethers.Wallet, btoken: string, side: Side, usdAmount: number ) {
    try {
        await this.openPosition(wlt!, btoken ,side,AmountType.QUOTE,Big(usdAmount),undefined,undefined,undefined)
        }
        catch (e: any) {
            console.error(`ERROR: FAILED OPEN. Rotating endpoint: ${e.toString()}`)
            this.ethService.rotateToNextEndpoint()
            await this.openPosition( wlt!,btoken,side,AmountType.QUOTE, Big(usdAmount),undefined,undefined,undefined )
            console.log("Re-oppened...")
        }
 }

 // close sort of dtor. do all bookeeping and cleanup here
 //REFACTOR: this.close(mkt) will make it easier for functinal styling
  async close(mkt: Market) {
    try {
        await this.closePosition(mkt.wallet, mkt.baseToken, undefined,undefined,undefined)
        //bookeeping: upd startCollateral to settled and save old one in basisCollateral
        let scoll = (await this.perpService.getAccountValue(mkt.wallet.address)).toNumber()
        mkt.basisCollateral = mkt.startCollateral
        mkt.startCollateral = scoll
        }
    catch (e: any) {
            console.error(`ERROR: FAILED CLOSE. Rotating endpoint: ${e.toString()}`)
            this.ethService.rotateToNextEndpoint()
            // one last try....
            await this.closePosition(mkt.wallet, mkt.baseToken, undefined,undefined,undefined)
            console.log("RECOVERY: closed after rotation")
            throw e  
    }
 }
// simpler override for close
async closeMkt( mktName: string) {
    let mkt = this.marketMap[mktName]
    try {
        await this.closePosition(mkt.wallet, mkt.baseToken, undefined,undefined,undefined)
        }
        catch (e: any) {
            console.error(`ERROR: FAILED CLOSE. Rotating endpoint: ${e.toString()}`)
            this.ethService.rotateToNextEndpoint()
            await this.closePosition(mkt.wallet, mkt.baseToken, undefined,undefined,undefined)
            console.log("closed...")
            // AYB Making it throwable
            throw e
        }
 } 

//----------------------------------
//maxCumLossCheck(mkt: Market): Result<number> { return {value: null } }
// DESCRPT test if a batok (base token) had ended roll and computes TW stats
// PRECOND none. check on each cycle
// POSITVE if both mkt and twin are sleeping. triggers: rollStartTest

async rollEndTest(market: Market): Promise<boolean> { 
    let check = false
    let mkt = this.marketMap[market.name]
    let twin = this.marketMap[market.twin]
    // dont rely on active. probably should remove pay the price for a single read in lieu of gas wasted and complexity
    let pos = (await this.perpService.getTotalPositionValue(mkt.wallet.address, mkt.baseToken)).toNumber()
    let twinpos = (await this.perpService.getTotalPositionValue(twin.wallet.address, mkt.baseToken)).toNumber()

    if (!pos && !twinpos ) {
        let tstmp = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
        // note. onClose startCollateral has the settled collateral after close settled
        console.log(tstmp + ": ROLL.END[" + market.name + "] Coll: " + mkt.startCollateral + "'" + twin.startCollateral)
        check = true
    }
    return check
}

//----------------------------------
// if sideless open mkt and twin. else only the favored of the twins
// ASSERT mkt and twin have no position

async awakeMktAndOrTwin(market: Market): Promise<Result<boolean>> { 
    let check = false
    let mkt = this.marketMap[market.name]
    let twin = this.marketMap[market.twin]

    let sz = this.marketMap[market.name].startCollateral * this.marketMap[market.name].leverage
    let sztwin = this.marketMap[twin.name].startCollateral * this.marketMap[twin.name].leverage

    if (this.holosSide == null ){ // open both 
        try {
            await this.open(mkt.wallet,mkt.baseToken,mkt.side,sz)
            this.marketMap[market.name].active = true  // REMOVE ME!!!!!
            await this.open(twin.wallet,mkt.baseToken,mkt.side,sztwin)
            this.marketMap[twin.name].active = true  // REMOVE ME!!!!!
            check = true
        }
        catch(err) {
            console.error("OPEN FAILED in awakeMktAndOrTwin")
        }
    }
    else {  // sided market
        let favored = (this.holosSide == mkt.side) ? mkt : twin
        let szfav = favored.startCollateral * favored.leverage

        try {
            await this.open(favored.wallet,mkt.baseToken,favored.side,szfav)
            this.marketMap[market.name].active = true  // REMOVE ME!!!!!
            check = true
        }
        catch(err) {
            console.error("OPEN FAILED in awakeMktAndOrTwin")
        }
    }

    return { positive: check}
}
//----------------------------------------------------------------------------------------------------------
// DESC: if both dados are stopped then is end of roll and rethrow both dados
// COND-ACT: 
// SIDEff: startCollateral at the very beginging rather than read from config
// TODO.FIX rmv collatera reding from config
// Error: throw if unable to open/close
//----------------------------------
// REMOVE ME
/*
async rollEndCheck(market: Market): Promise<Result<boolean>> {
// overkill is just returning condition: (!mkt.active && !mkt.twin.active)
// can be taken out if you add mkt.twin property

    let check = false
    // if market is still active then the condition is false. dont bother check twin
    if (this.marketMap[market.name].active) { return {result: check}}
    // check if twin is active
    let twin, tside, side = null
    if ( market.name.endsWith("SHORT") ) {
            twin = market.name.split("_")[0]
    } else {
            twin = market.name + "_SHORT"
    }
    if(this.marketMap[twin].active == false) {
        // both dados inactive => ROLL.END
        check = true
    }
    return { result: check} 
/*
    const vault = this.perpService.createVault()
    // cmp collat, freec if the same this dado ended. if twin also ended then is end of ROLL
    let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(market.name)!)

    const coll =  (await this.perpService.getAccountValue(wlt.address)).toNumber()
    const freec = (await this.perpService.getFreeCollateral(wlt.address)).toNumber()

    if (coll == freec) {
        // this dado stopped. set to inactive and then check if twin also stopped ie inactive
        this.marketMap[market.name].active = false
        let twin, tside, side = null
        if ( market.name.endsWith("SHORT") ) {
            twin = market.name.split("_")[0]
            tside = Side.LONG
            side = Side.SHORT
        } else {
            twin = market.name + "_SHORT"
            tside = Side.SHORT
            side = Side.LONG
        }
        
        if( this.marketMap[twin].active = false) {
            // both dados inactive => ROLL.END
            check = true
            console.log("ROLL END: " + market.name + " " + coll.toFixed(4) + "," + twinCol.toFixed(4))
        }

        let twinWlt = this.ethService.privateKeyToWallet(this.pkMap.get(twin)!)
        let twinCol = (await this.perpService.getAccountValue(twinWlt.address)).toNumber()
        let twinFreec = (await this.perpService.getFreeCollateral(twinWlt.address)).toNumber()

        if (twinCol == twinFreec) { 
            // both dados stopped OR first time running. either way new roll and startColl to actual
            //TODO.ASSERT startCollat == margin
           check = true
            console.log("ROLL END: " + market.name + " " + coll.toFixed(4) + "," + twinCol.toFixed(4))
        }
        
    }
    return { value: check }
    
  }
*/

//-----------------------------------------------------------------------------------------------------------
// losing gang has been identified however will pardon anyone in the loser gang with good perf 
// e.g TP_MIN_PARDON_RATIO > 1.1
// ASSERT holosSide is NOT null and changed from one non-zbra to another non-zbra
async putWrongSideToSleep() : Promise<Result<boolean>> {
    let check = false
    let errStr = ""
    // only the undead can go to sleep
    let activeMkts = Object.values(this.marketMap).filter(m => m.active == true).map( m => m.name)
    // groupby long/short gangs among the actives
    const longShortGang = activeMkts.reduce<{ sgang: string[], lgang: string[] }>
                            ((acc, item) => { item.endsWith("SHORT") ? acc.sgang.push(item) : acc.lgang.push(item);return acc; }, 
                                            { sgang: [], lgang: [] })
    // put on death row mkts in the 'wrong' side. side was updated in oneSidedMarketSwitch                     
    let deathrow = (this.holosSide == Side.SHORT) ? longShortGang.lgang : longShortGang.sgang
    // spare the good performers in the losing gang
    let pardonned = Object.values(deathrow).filter((n) => this.marketMap[n].basisCollateral/this.marketMap[n].startCollateral > config.TP_MIN_PARDON_RATIO )
    let toExecute = deathrow.filter( (n) => !pardonned.includes(n) )
    //let funcs: Array<closeFuncType> = []
    // closing the losers
    if(toExecute.length)
        for (const m of deathrow ) {
            const w = this.ethService.privateKeyToWallet(m)
            const b = this.marketMap[m].baseToken
            const n = this.marketMap[m].name
            try {
                await this.close(this.marketMap[n])
                // this.close will take care of updating start/basisCollat 
                this.marketMap[n].active = false // REMOVE ME!!
            }
            catch {
                errStr += "QRM.Close failed:" + n 
            }
            check = true
        }
    return {positive: check, error: Error(errStr) }
}


// DESC: Test for Regime Switch. updates this.holos.side accordingly
// POSITIVE:
// qrom.close. if crossed threshold send a list of arrest to filter deathrows
// test positive means is NOT null and turned to one Side
// positive if there is a HolosRegime change from one of the 3 states null, long, short
// regime switch is based on qurom on BOTH active/inactive mkts with a minum number of long/short
// required e.g for 2/3 then 5 modulus 2*5/3 => 2 for 6  => modulus 2*6/3 = 4
// criteria to count towards minimum is collateral return is below TP_COLRATIO_MAX which should be 
// <= TP_MAX_LOSS
// ASSERT TP_MIN_COL_RATIO > TP_MAX_LOSS
// Critera for regime switch: collateral/startCollateral == MaxLoss collateral ratio
// Criterial can be cusotmizez

async oneSidedMarketSwitch() :Promise<boolean> {
    // true only if mkt switch from null to one sided OR sides flipped e.g from rally to bear
    let check = false
    if (this.holosSide && (this.prevHolsSide != this.holosSide) ) 
    {
        // find minimum number of long/short mkts to meet qurom. 
        // REFACTOR. hardcoded qurome to 2/3
        let btokCount = Object.keys(this.marketMap).length/2
        let minQrmCount = Math.floor(2*btokCount/3) 
        // groupBy sides long/short
        const longShortGrp = Object.values(this.marketMap).map( m => m.name).reduce<{ shortGang: string[], longGang: string[] }>
                            ((acc, item) => {
                             item.endsWith("SHORT") ? acc.shortGang.push(item) : acc.longGang.push(item); return acc;
                            }, { shortGang: [], longGang: [] })
        // sidSwitch criteria defined as the side with qrom of big losers i.e lt TP_MIN_COL_RATIO lte TP_MAX_LOSS
        // i.e side is the OPPOSITE of whoever gang has the larger number of BigLosers defined as having worse than TP_MIN_COL_RATIO
        //filter long/short meet criteria. MUST include both active and closed                    
        let longBigLosers = longShortGrp.longGang.filter
                ( n => this.marketMap[n].basisCollateral/this.marketMap[n].startCollateral < config.TP_MIN_COL_RATIO )
        let shortBigLosers = longShortGrp.shortGang.filter
                ( n => this.marketMap[n].basisCollateral/this.marketMap[n].startCollateral < config.TP_MIN_COL_RATIO ) 
        //Lets find the biggest losser
        let lgangScore = longBigLosers.length
        let sgangScore = shortBigLosers.length 
        if (lgangScore >= minQrmCount && sgangScore < minQrmCount) {
            this.prevHolsSide = this.holosSide //save before overwrite
            this.holosSide = BEAR
        }
        else if (sgangScore >= minQrmCount && lgangScore < minQrmCount) {
            this.prevHolsSide = this.holosSide 
            this.holosSide = BULL
        }
        check = true
        let tstmp = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
        console.log(tstmp + ": RegimeSwitch:" + this.holosSide)
    }
    return check
}  

async putMktToSleep(mkt: Market) {
    try {
        await this.close(mkt) 
        this.marketMap[mkt.name].active = false  //REMOVE ME!!!!
    }
    catch(err) {
        console.error("Failed closed in putMktToSleep")
    }
    // compute terminal wealth contribution before overwrite
            //let colZero = mkt.startCollateral 
            // below no longer needed done in dtor/close
            //let scoll = (await this.perpService.getAccountValue(mkt.wallet.address)).toNumber()
            //this.marketMap[mkt.name].startCollateral = scoll
            // note: this.close takes care of updating collat values
            let oldStartCol = mkt.basisCollateral
            let settledCol = mkt.startCollateral //updated in this.close
            let ret = 1 + (settledCol-oldStartCol/oldStartCol)
            let tstmp = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
    console.log(tstmp + ": ROLL.Dado[ " + mkt.name + " ] END, stldcoll: " + settledCol + "ret: " + ret)
}

//----------------------------------------------------------------------------------------------------------
// OJO: CURRENTLY combining lMit and maxLoss. into tmpMitCheck for w-end urn
// COND-ACT: on TP_MAX_LOSS close leg. When twin MAX_LOSS (pexit) rollStateCheck will restart
// SIDEff: mkt.startCollatera onClose and also on new peak
// Error: throws open/close
// NOTE: when dado is stopped 
//----------------------------------

async maxLossTestUpdPeak(mkt: Market): Promise<boolean> {
    // skip if market inactive
    let check = false
    if (this.marketMap[mkt.name].active) { 
        // collatbasis is the peak colateral
        let collatbasis = mkt.basisCollateral
        const col = (await this.perpService.getAccountValue(mkt.wallet.address)).toNumber()
        let uret = 1 + (col - collatbasis)/collatbasis
        if (uret < config.TP_MAX_ROLL_LOSS ) {
            check = true // mark check positive 
        }
        // peak update
        // startCollateral is always realized. basisCollateral unrealized
        if (col > collatbasis) { 
            mkt.basisCollateral = col 
        }  
        console.log(mkt.name + " cbasis:" + mkt.basisCollateral.toFixed(2) + " uret:" + uret.toFixed(4))
    } 
    return check 
  }

    async arbitrage(market: Market) {
            if ( await this.maxLossTestUpdPeak(market) ) {   // have a positive => close took place. check for qrom crossing
                this.putMktToSleep(market)
            }
            // REFAC regimeSwitchOnCollat(criteria =RatioTest)
            if (await this.oneSidedMarketSwitch() ) {   // swith from zbra to bull/bear or bull<->bear
                await this.putWrongSideToSleep()        // all active lgang or sgang. unless winner among losers
            }
            // ROLL.END.Condition: (!mkt.active &&  !mk.twin.active)
            if (await this.rollEndTest(market)) {
                await this.awakeMktAndOrTwin(market)
            }
 
/* HIDE        
        //--- Get pnl/free collat
        //--- factor out to avoid recomputing unnecesary on most cycles
        let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(market.name)!)
        let freec = (await this.perpService.getFreeCollateral(wlt!.address)).toNumber()
        const perpPnl = (await this.perpService.getOwedAndUnrealizedPnl(wlt.address)).unrealizedPnl.toNumber()
        let side = market.name.endsWith("SHORT") ? Side.SHORT : Side.LONG
        let offsetSide = (side == Side.SHORT) ? Side.LONG : Side.SHORT
        //let offsetSide = side.endsWith("SHORT") ? Side.LONG : Side.SHORT
        // current collateral needed to compute actual loss to add to cumulative loss. mr = [upnl + collat]/position value
        let absNotional = (await this.perpService.getTotalAbsPositionValue(wlt.address)).toNumber()
        let mr = (await this.perpService.getMarginRatio(wlt.address))!.toNumber()
        let lvrj = this.marketMap[market.name].leverage
        let loss = null
        let actualProfit = null
        let uret = null
        
        //let uret = 1 + upnl/this.marketMap[market.name].collateral

        //--------------------------------------------------------------------------------------------------------------------
        //   Handle negative pnl 
        //--------------------------------------------------------------------------------------------------------------------
        if (perpPnl < 0) {
        // 0. A) mir check, B) umLoss check, C) RollStateTransition. onLoss responsable to update cumLoss
        // 1. A. compute pnl via marginRatio: mr = [collat + pnl]/abs(notionalValue) => pnl = notionalVal*mr - collateral
        // 2. A. update cumulativeLoss and then decide if to actually offset partially, coplete (reopen), suspended
        //    suspended means shoud have offset but will only do it on paper
        // 2. A. update leverage (deleverage)
        // 3. B. cumLoss already reflecting loss, simply check if triggered
        // 4. B. flag if we are at RollState.END i.e was a Fav leg ie collat > START
        // 5. B. close if meet criteria. No partial or suspended
        // 6. C. Roll State machine transition
        // ret = 1 + DltaNV/nvz, DltaNV = mr*nvz-collat; . dltaNZ is my computed pnl
        // cumLoss is *ONLY* realized losses by offset (including suspended offsets)
        // if projectedCumloss > MAX_LOSS => then add it to trigger a maxLoss exit

        // nv: notianol value, dltaNVZ aka pnl
        //let nvz = this.marketMap[market.name].notionalBasis // onStart nvz = START_CAT * lvrj
        let upnl = absNotional*mr-this.marketMap[market.name].collateral  //derive pnl from margin
        let adjLoss = Math.abs(upnl/config.TP_EXECUTION_HAIRCUT)
        let newlvrj = config.TP_DELEVERAGE_FACTOR*lvrj // in case need to offset
        uret = 1 - adjLoss/this.marketMap[market.name].collateral

        // collateral and notionalvalzero nvz updated in onScale. onLoss manges cumLoss which is based on nvz
        // if cumLoss(START,pnl) > loss(collatera,nvz) => update cumLoss

        // 1. collat DECrement on mir check. MAX(START,mkt.collateral+=adjLoss)  
        // 2. cumLossI  INCrmt on cumLoss check MAX(mtk.Closs, mkt.Closs +adjLoss )
        // 1,2 do always, mir execution ONLY if above minimum, CumLoss execution even if too smal
        //------------------- [ mir check ] ------------------------------------------------------
        if( uret < this.marketMap[market.name].minReturn ) { 
            // initialize loss to adjLoss in case is a suspended offset
            loss = adjLoss
            //let finalCol = Math.max( config.TP_START_CAP -= adjLoss, this.marketMap[market.name].collateral) += actualLoss
            //let finalCumLoss = this.marketMap[market.name].cummulativeLoss += actualLoss
            if (freec > adjLoss ) { //--- reduce position if enough freec --
                if (adjLoss > config.TP_EXEC_MIN_PNL) {
                    await this.open(wlt!,this.marketMap[market.name].baseToken,offsetSide,adjLoss*lvrj)
                    //calc coll (loss) [(mr*posVal-pnl), where pnl = 0 right after open] - collzero
                    let mr = (await this.perpService.getMarginRatio(wlt.address))!.toNumber()
                    // overwrie loss to use the actual loss
                    loss = mr!*absNotional - this.marketMap[market.name].collateral
                }
                else { // amount too small to execute but still count as an (urealiaze) loss
                    console.log("INFO:" + loss.toFixed(2) + " Too small loss to exec: " + market.name )
                    //loss = -adjLoss // will use this estimated loss since we will not have an actual offseting
                }
                
            }
            else { //---- insufficient freec.close and reopen UNLIKELY to be less than TP_EXEC_MIN_ PNL. 
                   await this.close( wlt!, market.baseToken) 
                   //compute actual loss using current collat == free collateral
                   let ccollat = (await this.perpService.getFreeCollateral(wlt!.address)).toNumber()
                   loss = ccollat - this.marketMap[market.name].collateral
                   //delverage reopen 
                   await this.open(wlt!, this.marketMap[market.name].baseToken,side,ccollat*lvrj)
                   console.log("INFO, insuficient freec" +"," + market.name + " final collat:" + ccollat)
            }

            //let rsz = await this.perpService.getTotalPositionSize(wlt.address, market.baseToken)
            // regardless what type of offseting we inc cumLoss
            this.marketMap[market.name].cummulativeLoss =+ Math.abs(loss)
            this.marketMap[market.name].leverage *= config.TP_DELEVERAGE_FACTOR // <-- Max(esto or TP_MIN_LEVERAGE)
            // update collateral otherwise next uret will be calculated against wrong basis and in immieate uret loss trigger
            // OJO loss is negavite
            this.marketMap[market.name].collateral =+ loss

            let ts = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
            console.log(ts + ",LMit:" + market.name + " aloss:" + loss.toFixed(4) + " cumLoss:" +
                        this.marketMap[market.name].cummulativeLoss.toFixed(4))
        } // end of mir check
        //------------------- [ cumLoss check ] ------------------------------------------------------
        // unrealized-cumulative- loss (ucl) ret relative to initial basis 1 + (basis+cumloss -basis + upnl)/basis =>
            // uret (cumLoss + upnl)/initialSeed. unrealizedCummulativeLoss
            // if collateral < initial collateral use seed capital so we clip the worse path for 
        // if above then use peak collateral. rr is rollreturn 
            //let projCumLoss = this.marketMap[market.name].cummulativeLoss + upnl
            //TODO.NEXT <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
            //if this.marketMap[market.name].collateral >  config.TP_START_CAP RollState = END
            //<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
            //let basis = Math.max(this.marketMap[market.name].collateral, config.TP_START_CAP) 
            //let basis = (this.marketMap[market.name].collateral > config.TP_START_CAP) ? this.marketMap[market.name].peakCollateral : config.TP_START_CAP
            let rollRet = 1 - this.marketMap[market.name].cummulativeLoss/this.marketMap[market.name].startCollateral
            if (rollRet < config.TP_MAX_ROLL_LOSS ) {
                await this.close( wlt!, market.baseToken) 
                
                console.log("EVENT:" + market.name + "MAX_LOSS_ROLL reached. CumLoss " + this.marketMap[market.name].cummulativeLoss)
                delete this.marketMap[market.name]
                //exit main loop
                return 
            }
            //--- beats Print info: pnl, returns
            console.log(market.name + ": adjLoss:" + adjLoss.toFixed(4) + 
                        " mr:" + mr!.toFixed(4) + " uret: " + uret.toFixed(4))    
            //console.log(market.name + ":cl:" + this.marketMap[market.name].cummulativeLoss.toFixed(4))
        } // end of negative upnl 

        //--------------------------------------------------------------------------------------------------------------------
        //   Handle positive pnl 
        //--------------------------------------------------------------------------------------------------------------------
        // 0. onScale UPDATEr: notionalBasis, collateral which should implact onLoss calculations
        // compute internal pnl relative to 'imaginary' collateral, i.e the collateral i would have invested to 
        // at START_LEVERAGE e.g if with 10 collateral at 3x, Notional jumps from 30 to 60, with the new notional basis
        // is as if i had started with a icoll = 20 => collatgain = 20-10 = $10 => uret = 1 + DltNotional/icollot 
        // mrZero = [icoll + DLT(N)]/N => icoll = mrz*N - [N-Nbasis]
        // notionalBasis will be the highest running peak
        // 1. mar checking
        let upnl = mr*absNotional - this.marketMap[market.name].collateral 
        //if ( (perpPnl > 0) && (absNotional > this.marketMap[market.name].notionalBasis) ) {
        if ( (perpPnl > 0) && ((upnl > this.marketMap[market.name].maxPnl) ) ) {  
                this.marketMap[market.name].maxPnl = upnl
                let icoll = this.marketMap[market.name].collateral + config.TP_EXECUTION_HAIRCUT*upnl
            //let mrZero = 1/this.marketMap[market.name].resetLeverage
            //let DltNotional = absNotional - this.marketMap[market.name].notionalBasis
            //let icoll = mrZero*absNotional - DltNotional
            //let upnl = icoll - this.marketMap[market.name].collateral 

            
            uret = 1 + upnl/this.marketMap[market.name].collateral
            console.log(market.name + " icoll: " + icoll.toFixed(4) 
                        + " peakPnl:" + this.marketMap[market.name].maxPnl.toFixed(4) + "coll: " + 
                           this.marketMap[market.name].collateral + " uret: " + uret.toFixed(4))

            if( uret > this.marketMap[market.name].maxReturn ) { 
                let newlvrj = config.TP_RELEVERAGE_FACTOR*lvrj
                let adjRet = upnl*config.TP_EXECUTION_HAIRCUT  // reduce the nominal pnl to accoutn for execution cost
                
                if (freec > adjRet ) { //--- inc position if enough freec --
                    if (adjRet > config.TP_EXEC_MIN_PNL) {
                        await this.open(wlt!,this.marketMap[market.name].baseToken,side,adjRet*newlvrj)
                        //compute change in coll (abs return) [(mr*posVal-pnl), where pnl = 0 right after open] - collzero
                        let mr = (await this.perpService.getMarginRatio(wlt.address))!.toNumber()

                        //STOP PREMATURE OPTIMIZATON!!!! recompute absNotional it has changed!!! 
                        let absNotional = (await this.perpService.getTotalAbsPositionValue(wlt.address)).toNumber() 
                        actualProfit = mr!*absNotional - this.marketMap[market.name].collateral
                    }
                    else { // amount too small to execute but still count as an (urealiaze) loss
                        actualProfit = adjRet
                        console.log("INFO:" + adjRet.toFixed(2) + " Too small profit to exec: " + market.name )
                    }
                }
                else { //---- insufficient freec. close and reopen
                       await this.close( wlt!, market.baseToken) 
                       //compute abs ret using current collat == free collateral
                       let ccollat = (await this.perpService.getFreeCollateral(wlt!.address)).toNumber()
                       actualProfit = ccollat - this.marketMap[market.name].collateral
                       //releverage reopen 
                       await this.open(wlt!, this.marketMap[market.name].baseToken,side,ccollat*newlvrj)
                       console.log("INFO, Reopen" +"," + market.name)
                }

                this.marketMap[market.name].collateral = icoll
                this.marketMap[market.name].leverage *= newlvrj // <-- Max(esto or TP_MIN_LEVERAGE)
                this.marketMap[market.name].notionalBasis = icoll*newlvrj
                
                //let fcloss = this.marketMap[market.name].cummulativeLoss += actualProfit
    
                //let rsz = await this.perpService.getTotalPositionSize(wlt.address, market.baseToken)
                //--- print time, actual loss, newcoll, cumLoss
                
                let ts = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
                console.log(ts + ",SCALE:" + market.name +  "notl :" + absNotional.toFixed(4) + " icoll: " + icoll.toFixed(4) + " uret:" + uret)
            }
        }
HIDE */       
          

        /*
        console.log("INFO: " + mkt + ": pnl: " + upnl.toFixed(4) + " uret: " + uret.toFixed(4))
    
        if ( await this.isStopLoss(market.name)) 
        {
            this.log.jinfo({ event: "stop loss trigger", params: { market: market.name }, })
            let side = market.name.endsWith("SHORT") ? Side.SHORT : Side.LONG
            
            //TODO.OPTIMIZE avoid keep calculating wallet
            let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(market.name)!)
            await this.closePosition( wlt!, market.baseToken) 
            let newcoll = await this.perpService.getFreeCollateral(wlt!.address)

            // update cummulative loss
            let loss = newcoll.toNumber() - config.TP_START_CAP
            this.marketMap[market.name].cummulativeLoss = this.marketMap[market.name].cummulativeLoss + loss
                        
            //let newcoll = (await vault.getBalanceByToken(wlt.address, OP_USDC_ADDR)) / 10**6
            this.log.jinfo({ event: "lMit: ", params: { market: market.name, newColl: + newcoll }, })
            // TODO.NXT handle when absolute size below a minimum. $2 ? then mr=1
            // TODO.NXT wdraw TP_PEXIT_WITHDRAWL .10
            // TODO.NXT parametrize inconfig PEXIT and LEXIT
            //const TP_WITHDRAWL = 0.98

             // deleverage
            let mr = 1/this.marketMap[market.name].leverage
            let newlvrj = 1/Math.min(TP_MAX_MR, mr + TP_MR_INC_SZ)
            
            let reOpenSz = newlvrj*newcoll.toNumber()
            // TODO.STK  adjust default max gas fee is reasonable
            try {
            await this.openPosition(wlt!, market.baseToken,side,AmountType.QUOTE,Big(reOpenSz),undefined,undefined,undefined)
            }
            catch (e: any) {
                console.error(`FAILED OPEN: ${e.toString()}`)
                this.ethService.rotateToNextEndpoint()
                console.log("RETRY OPEN")
                await this.openPosition( wlt!, market.baseToken,side,AmountType.QUOTE, Big(reOpenSz),undefined,undefined,undefined )
            }
            
            this.marketMap[market.name].collateral = newcoll.toNumber()
            //let rsz = await this.perpService.getTotalPositionSize(wlt.address, market.baseToken)
            this.log.jinfo( {event: "Backoff", params: { market: market.name, ncoll: +newcoll,
                                                         nlvrj: newlvrj},} )
        }
        */
        // --------------------------------------------------------------------------------------------
        // check if scale trigger
        // --------------------------------------------------------------------------------------------
        // --- OJO: the key may have been removed  bcoz of MAX_ROLL_LOSS, but dont want to check
        // relying on the if statement evaluating to false for undefined
        /*
        if ( await this.isScaleTresh(market.name)) 
        {
            this.log.jinfo({ event: "scale trigger", params: { market: market.name }, })
            let side = market.name.endsWith("SHORT") ? Side.SHORT : Side.LONG
            // re-open at reset margin
            //TODO.OPTIMIZE avoid keep calculating wallet
            let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(market.name)!)

            await this.closePosition( wlt!, market.baseToken) 
            //let coll = await this.perpService.getFreeCollateral(wlt!.address)
            // rebase collateral
            //const vault = this.perpService.createVault()
            //const newcollat = (await vault.getBalanceByToken(wlt.address, OP_USDC_ADDR)) / 10**6
            let newcoll = await this.perpService.getFreeCollateral(wlt!.address)

            // TODO.NXT wdraw TP_PEXIT_WITHDRAWL .10

            // releverage
            let mr = 1/this.marketMap[market.name].leverage
            let newlvrj = 1/Math.max(TP_MIN_MR, mr - TP_MR_DEC_SZ)

            let reOpenSz = newlvrj*newcoll.toNumber()
            // TODO.STK  adjust default max gas fee is reasonable
            try {
            await this.openPosition(
                wlt!,
                market.baseToken,
                side,
                AmountType.QUOTE,
                Big(reOpenSz),
                undefined,
                undefined, // WAS: Big(config.BALANCE_MAX_GAS_FEE_ETH),
                undefined, //was this.referralCode,
            ) 
            }
            catch (e: any) {
                console.error(`Scale: FAILED OPEN: ${e.toString()}`)
                this.ethService.rotateToNextEndpoint()
                console.log("RETRY OPEN")
                await this.openPosition( wlt!, market.baseToken,side,AmountType.QUOTE,
                                         Big(reOpenSz),undefined,undefined,undefined )
            //let rsz = await this.perpService.getTotalPositionSize(wlt.address, market.baseToken)
            this.marketMap[market.name].collateral = newcoll.toNumber()
                }
            this.log.jinfo( {event: "Scale", params: { mkt: market.name, 
                                                       nlevrj: newlvrj, ncoll: +newcoll},} )
        }
        
    }*/
}