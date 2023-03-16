import { min } from "@perp/common/build/lib/bn"
import { EthService } from "@perp/common/build/lib/eth/EthService"
import { sleep } from "@perp/common/build/lib/helper"
import { Log } from "@perp/common/build/lib/loggers"
import { BotService } from "@perp/common/build/lib/perp/BotService"
import { AmountType, Side } from "@perp/common/build/lib/perp/PerpService"
import { CollateralManager, IClearingHouse } from "@perp/common/build/types/curie"
import { UniswapV3Pool } from "@perp/common/build/types/ethers-uniswap"
import BigNumber from 'bignumber.js';
import Big from "big.js"
import { ethers } from "ethers"
import { max, padEnd, update } from "lodash"
import { decode } from "punycode"
import { Service } from "typedi"
import config from "../configs/config.json"
import * as fs from 'fs'
import { tmpdir } from "os"
import { timeStamp } from "console"
import { Interface } from "readline"
//import { IUniswapV3PoolEvents } from "@perp/IUniswapV3PoolEvents";

require('dotenv').config();

const DBG_run = false 
// typedefs
type BaseTokenAddr = string
type EthersWallet = ethers.Wallet
type closeFuncType = (arg1: EthersWallet, arg2: BaseTokenAddr) => Promise<void>

enum Direction {
    ZEBRA = "zebra",
    TORO = "toro",
    BEAR = "bear"
}

type TickRecord = {
    timestamp: number
    tickDelta: number | null
  };

type CumulativeTick = {
    lastTimestamp: number;
    cumTick: number;
  };

interface PoolData {
    lastRecord: TickRecord 
    tickBuff: TickRecord[] //timestamp, tick raw
    currTickDelta: number, //latest delta computed by updatePoolData
    prevTickDelta: number, //previou delta saved by updatePoolData
    isRead: boolean
}  

const BEAR = Side.SHORT
const BULL = Side.LONG
//const ZBRA = (Side.NEUTRAL)  //TODO
//TESTING: block SOLShort: 65131100, 55746888
//TODO.REFACT put on utility function. Templetize
const TP_MIN_MR    = 0.12  // 8.33x
const TP_MR_DEC_SZ = 0.02
const TP_MAX_MR    = 0.50 
const TP_MR_INC_SZ = 0.02  // OJO you INC onStopLoss 5x

//decode function
function decodeEvt(unipool: UniswapV3Pool ,eventdata: any) {
    // should i use IUniswapV3PoolEvents and eventdata: ethers.Event?
    let evetdata = "0xBd7a3B7DbEb096F0B832Cf467B94b091f30C34ec"
    const decodedEventData = unipool.interface.decodeEventLog('Swap', eventdata);
          // Get the token addresses and tick of the event
            const token0Address = decodedEventData.token0;
            const token1Address = decodedEventData.token1;
            const tick = decodedEventData.tick;
            console.log("token0Address: ", token0Address);
}

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
  
interface PoolState {
    poolAddr: string,
    tick: number | undefined,
    prevTick: number | undefined,
    poolContract: UniswapV3Pool,
    //sqrtPriceX96: number, // 96 bits of precision. needed??
}  

interface Market {
    wallet: Wallet
    side: Side
    name: string
    tkr: string
//    active: boolean
    baseToken: string
    rollEndLock: boolean
    poolAddr: string
    longEntryTickDelta: number
    shortEntryTickDelta: number
    minReturn: number
    maxReturn: number
    uret: number  // unrealized return
    minMarginRatio: number
    maxMarginRatio: number
    basisCollateral: number // current collateral including pnl
    startCollateral: number // gets reset everytme we reopen
    initCollateral: number  // read from config aka seed
    twin: string
//    peakCollateral: number
    resetMargin: number
    //leverage: number
    resetNeeded:boolean
    resetSize: number
    cummulativeLoss: number
    //notionalBasis: number
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
    private holosSide: Direction = Direction.ZEBRA
    private prevHolsSide: Direction = Direction.ZEBRA
    private poolState: { [keys: string]: PoolState } = {}
    private poolData: { [ticker: string]: PoolData } = {}

    //DBGpoolETHcontract: UniswapV3Pool

    async setup(): Promise<void> {
        this.log.jinfo({ event: "Setup ONE.D",})
       // Print the names and values of all the variables that match the pattern 'v[A-Z]{3,}'
        const pattern = /^v[A-Z]{3,}/  
        let vk = Object.entries(process.env).filter(([k])=> pattern.test(k))

        for (const [key, value] of vk) {
            this.pkMap.set(key, value!);
          }
          
        // initilize pkMap
          let wlts = transformValues(this.pkMap, v => this.ethService.privateKeyToWallet(v))
        // needed by BotService.retrySendTx
        await this.createNonceMutex([...wlts.values()])
        
        this.createPoolStateMap()
        this.createPoolDataMap()
        // setup listeners for all node endpoints
        //not needed coz on rotate it will reregister listeners
        //for ( let i = 0; i < this.ethService.web3Endpoints.length; ++i )
   
        this.setupPoolListeners()
        await this.createMarketMap()
        
    }

    async DBG_setupPoolListeners(): Promise<void> {
        /*
        //for (const p of this.perpService.metadata.pools) {
        for (const symb in this.poolStateMap) {
            //const unipool = await this.perpService.createPool(this.poolStateMap[symb].poolAddr);
            //let unipool = this.DBGpoolETHcontract
            
            
            // setup Swap event handler
            unipool.on('Swap', (sender: string, recipient: string, amount0: Big, amount1: Big, sqrtPriceX96: Big, liquidity: Big, tick: number, event: ethers.Event) => {
                // update previous tick before overwriting
                this.poolStateMap[symb].prevTick = this.poolStateMap[symb].tick
                this.poolStateMap[symb].tick= tick
                // convert ticks to price: price = 1.0001 ** tick
                let price = 1.0001 ** tick

                const epoch = Math.floor(Date.now() / 1000).toString();
                // TURN OFF CONSOLE LOGGING. append to file
                //console.log(`${epoch}, ${symb}, ${this.poolStateMap[symb].prevTick}, ${this.poolStateMap[symb].tick}, ${price.toFixed(4)}`);
                const stream = fs.createWriteStream('ticks.csv', {flags:'a'} ); 
                stream.write(`${epoch}, ${symb}, ${this.poolStateMap[symb].prevTick}, ${this.poolStateMap[symb].tick}, ${price.toFixed(4)}\n`);
              });
            }
            */
    }
    // setup listeners for all pools
    // test event: 0xBd7a3B7DbEb096F0B832Cf467B94b091f30C34ec
    // IUniswapV3PoolEvents.events.Swap:
    /// @param sender The address that initiated the swap call, and that received the callback
    /// @param recipient The address that received the output of the swap
    /// @param amount0 The delta of the token0 balance of the pool
    /// @param amount1 The delta of the token1 balance of the pool
    /// @param sqrtPriceX96 The sqrt(price) of the pool after the swap, as a Q64.96
    /// @param liquidity The liquidity of the pool after the swap
    /// @param tick The log base 1.0001 of price of the pool after the swap

    async BKPsetupPoolListeners(): Promise<void> {
        //for (const p of this.perpService.metadata.pools) {
        for (const symb in this.poolState) {
            //const unipool = await this.perpService.createPool(this.poolStateMap[symb].poolAddr);
            let unipool = this.poolState[symb].poolContract
            // setup Swap event handler
            unipool.on('Swap', (sender: string, recipient: string, amount0: Big, amount1: Big, sqrtPriceX96: Big, liquidity: Big, tick: number, event: ethers.Event) => {
                // update previous tick before overwriting
                this.poolState[symb].prevTick = this.poolState[symb].tick
                this.poolState[symb].tick= tick
                // convert ticks to price: price = 1.0001 ** tick
                let price = 1.0001 ** tick

                const epoch = Math.floor(Date.now() / 1000).toString();
                // TURN OFF CONSOLE LOGGING. append to file
                //console.log(`${epoch}, ${symb}, ${this.poolStateMap[symb].prevTick}, ${this.poolStateMap[symb].tick}, ${price.toFixed(4)}`);
                const stream = fs.createWriteStream('ticks.csv', {flags:'a'} ); 
                stream.write(`${epoch}, ${symb}, ${this.poolState[symb].prevTick}, ${this.poolState[symb].tick}, ${price.toFixed(4)}\n`);
              });
            }
    }
    //--------------------------------------------------------------------------------
    // setup listeners for all pools
    // responsable to update the poolData.tickLog used in updatePoolData to compute the cumulative tick changes
    //--------------------------------------------------------------------------------
    async setupPoolListeners(): Promise<void> {
        //for (const p of this.perpService.metadata.pools) {
        for (const symb in this.poolState) {
            //const unipool = await this.perpService.createPool(this.poolStateMap[symb].poolAddr);
            let unipool = this.poolState[symb].poolContract
            // setup Swap event handler
            unipool.on('Swap', (sender: string, recipient: string, amount0: Big, amount1: Big, sqrtPriceX96: Big, 
                                liquidity: Big, tick: number, event: ethers.Event) =>
                        { // poolDataupdate will drain tickLog
                            const timestamp = Math.floor(Date.now())
                            this.poolData[symb].tickBuff.push({ timestamp: timestamp, tickDelta: tick})
                            //this.poolData[symb].lastTick = tick
                            // if data has been read then empty tickLog
                            //>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
                            if (this.poolData[symb].isRead == true) {
                                this.poolData[symb].tickBuff.splice(0, this.poolData[symb].tickBuff.length - 1);
                                this.poolData[symb].isRead = false
                            }

                        })
        }   
    }

    createPoolStateMap() {
        for (const pool of this.perpService.metadata.pools) {
            const poolContract = this.perpService.createPool(pool.address)
            this.poolState[pool.baseSymbol] = { 
                poolAddr: pool.address,
                poolContract: poolContract,
                tick:0,  // otherwise wakeup check will choke
                prevTick: 0,
              };
        }
    }

    // init PoolData for all pools
    createPoolDataMap() {
        for (const pool of this.perpService.metadata.pools) {
          this.poolData[pool.baseSymbol] = { 
            lastRecord: {tickDelta: 0, timestamp: 0},
            tickBuff: [],
            prevTickDelta: 0,
            currTickDelta: 0,
            isRead: false,
          };
        }
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
                tkr:marketName.split('_')[0],
                wallet: this.ethService.privateKeyToWallet(this.pkMap.get(marketName)!),
                side: marketName.endsWith("SHORT") ? Side.SHORT : Side.LONG,
                baseToken: pool.baseAddress,
                poolAddr: pool.address,
                //TODO.RMV order amount
                orderAmount: Big(666),
                minReturn: market.MIN_RETURN,
                maxReturn: market.MAX_RETURN,
                uret: 1,
                minMarginRatio: market.MIN_MARGIN_RATIO,
                maxMarginRatio: market.MAX_MARGIN_RATIO,
                initCollateral: market.START_COLLATERAL,  // will not change until restart
                startCollateral: market.START_COLLATERAL, // will change to previous settled collatera
                basisCollateral: market.START_COLLATERAL, // incl unrealized profit
                resetMargin: market.RESET_MARGIN,
                longEntryTickDelta: market.TP_LONG_MIN_TICK_DELTA,
                shortEntryTickDelta: market.TP_SHORT_MIN_TICK_DELTA,
                cummulativeLoss: 0,
                maxPnl: 0,
                //notionalBasis: config.TP_START_CAP/market.RESET_MARGIN,
                //TODO.rmv
                rollEndLock:false,
                resetNeeded: false,
                resetSize:0,
                twin: marketName.endsWith("SHORT") ? marketName.split("_")[0] : marketName + "_SHORT"
            }
        }
    }

    async start(): Promise<void> {
        //TODO.BIZCONT renable rotation to do the health checks
        this.ethService.enableEndpointRotation()
        this.arbitrageRoutine()
    }


    async arbitrageRoutine() {
        while (true) {
            //TODO.STK turn on heart beat below
            //this.markRoutineAlive("ArbitrageRoutine")
            await Promise.all(
                Object.values(this.marketMap).map(async market => {
                    try {
                        // Biss 
                        //await this.arbitrage(market)
                        await this.checksRoutine(market)
                    } catch (err: any) {
                        await this.jerror({ event: "ArbitrageError", params: { err } })
                    }
                }),
            )
            await sleep(config.PRICE_CHECK_INTERVAL_SEC * 1000)
        }
    }

    
//------------------
// updatePoolData() accumulates tick changes for a given TP_TICK_TIME_INTERVAL, needed to gestimate if there is unidirection
 //------------------

 updatePoolData(): void {
 for (const symb in this.poolState) {   
    //let poolData  = this.poolData[symb]
    if (this.poolData[symb].tickBuff.length == 0) { continue }
    //const lastUpdate = poolData.lastTick // last tick update for this ticker
    // drain tickLog into ticks
    //const tsticks = [...this.poolData[symb].tickLog]
     // take the difference btw last and first in tickLog  
    //const tickDelta = tsticks[tsticks.length-1].tick! - tsticks[0].tick!
    if (this.poolData[symb].tickBuff.length == 0) { 
        console.log(symb + " DEBUG: should not be here" + this.poolData[symb].lastRecord?.tickDelta)
        //victim of race condition. skip and see if next round will work
        continue
    }
    // get tick delta from the tickBuff. Diff btw last and first in the buffer
    const len = this.poolData[symb].tickBuff.length
    const tickDelta = this.poolData[symb].tickBuff[len-1].tickDelta! - this.poolData[symb].tickBuff[0].tickDelta!
    // set flag to let handler to reset tickLog
    
    // weird behavior if i just nuke the array. instead pop all except last item
    //this.poolData[symb].tickLog = []
    //while (this.poolData[symb].tickLog.length) { this.poolData[symb].tickLog.pop()}
      
    this.poolData[symb].lastRecord.tickDelta = tickDelta
    this.poolData[symb].lastRecord.timestamp = Date.now()
    //TODO.DEBT HACK work aournd the race condition. wrap in a setter/getter with mutex
    // flag handler that ok to discard current buffer and start a new one (or throw old entries)
    this.poolData[symb].isRead = true

    //this.poolData[symb].prevTickDelta = this.poolData[symb].currTickDelta
    this.poolData[symb].currTickDelta = tickDelta

    const csvString = `${symb},${Date.now()},${tickDelta}\n`;
    console.log(csvString)
    fs.appendFile('cumticklog.csv', csvString, (err) => { if (err) throw err });
    //TODO.DEBT need to handle this file resource
    // getting race condition
    

    /*const csvString = `${symb},${cumTick.lastTimestamp},${cumTick.cumTick}\n`;
fs.appendFile('cumticklog.csv', csvString, (err) => {
  if (err) throw err;
  console.log(`Wrote entry to cumticklog.csv: ${csvString}`);
});
    const cumTick: CumulativeTick = msticks.reduce((acc, val) =>
     {
        return { lastTimestamp: Date.now(), cumTick: acc.cumTick + (val.tick ?? 0) };
        }, {lastTimestamp: 0, cumTick: 0});

    
    const deltaTicks = poolData.tickDeltaHist;
  
    // Calculate the start and end timestamps for the time interval
    const startTime = lastUpdate
    // if we got here, there is at least one tick in the log with a timestamp
    const endTime = lastUpdate! + 1000*config.TP_TICK_TIME_INTERVAL_SEC;
  
    // Find the index of the first tick that's after the start time
    let firstIndex = tickLog.findIndex((tk) => tk.timestamp >= startTime!);
//    let firstIndex = tickLog.findIndex((tk) => tk.timestamp > startTime!);
  
    // If there are no ticks after the start time, or empty, skip
    if (firstIndex === -1 || tickLog.length == 0 ) { continue }
  
    // Calculate the cumulative tick for the time interval
    let cumTick = 0;
    let i = firstIndex;
    while (i < tickLog.length && tickLog[i].timestamp < endTime) {
      cumTick += tickLog[i].tick!;
     i++;
    }
    deltaTicks.push({ lastTimestamp: endTime, cumTick: cumTick})
    // Update the lastUpdate timestamp
    this.poolData[symb].lastTickUpdate = endTime
     */
 }

}


 async getPosVal(leg: Market): Promise<Number> {
    let pv =  (await this.perpService.getTotalPositionValue(leg.wallet.address, leg.baseToken)).toNumber()
    return pv
 }


 async nonZeroPos(leg: Market): Promise<boolean> {
    let pos = (await this.perpService.getTotalPositionValue(leg.wallet.address, leg.baseToken)).toNumber()
    return (pos != 0)
 }

 async open(mkt: Market, usdAmount: number ) {
    if (config.DEBUG_FLAG) {
        console.log("DEBUG: open: " + mkt.name + " " + usdAmount)
        return
    }
    try {
        await this.openPosition(mkt.wallet, mkt.baseToken ,mkt.side ,AmountType.QUOTE,Big(usdAmount),undefined,undefined,undefined)
            // no garanteed that collateral basis/start were updated on the assumed previous close
            let scoll = (await this.perpService.getAccountValue(mkt.wallet.address)).toNumber()
            mkt.basisCollateral = scoll
            mkt.startCollateral = scoll
        }
        catch (e: any) {
            console.error(`ERROR: FAILED OPEN. Rotating endpoint: ${e.toString()}`)
            this.ethService.rotateToNextEndpoint()
            await this.openPosition( mkt.wallet,mkt.baseToken,mkt.side,AmountType.QUOTE, Big(usdAmount),undefined,undefined,undefined )
            console.log("Re-oppened...")
        }
 }
/*
 async open(wlt: ethers.Wallet, btoken: string, side: Side, usdAmount: number ) {
    try {
        await this.openPosition(wlt!, btoken ,side,AmountType.QUOTE,Big(usdAmount),undefined,undefined,undefined)
                let scoll = (await this.perpService.getAccountValue(mkt.wallet.address)).toNumber()
        }
        catch (e: any) {
            console.error(`ERROR: FAILED OPEN. Rotating endpoint: ${e.toString()}`)
            this.ethService.rotateToNextEndpoint()
            await this.openPosition( wlt!,btoken,side,AmountType.QUOTE, Big(usdAmount),undefined,undefined,undefined )
            console.log("Re-oppened...")
        }
 }*/

 // close sort of dtor. do all bookeeping and cleanup here
 //REFACTOR: this.close(mkt) will make it easier for functinal styling
 // onClose startCollateral == basisCollateral == settledCollatOnClose
 rotateToNextProvider() {
    // upon running eth.rotateToNextEndpoint. listeners are lost. need to re-register against new provider in ethService
    this.ethService.rotateToNextEndpoint()
    this.setupPoolListeners()
    let tmstmp = new Date().toLocaleTimeString([], {hour12: false, timeZone: 'America/New_York'});
    console.log(tmstmp + " SETUP: rereg listeners: " + this.ethService.provider.connection.url)
 }

async BKPclose(mkt: Market) {
    try {
        await this.closePosition(mkt.wallet, mkt.baseToken, undefined,undefined,undefined)
        //bookeeping: upd startCollateral to settled and save old one in basisCollateral
        let scoll = (await this.perpService.getAccountValue(mkt.wallet.address)).toNumber()
        mkt.basisCollateral = scoll
        mkt.startCollateral = scoll
        }
    catch (e: any) {
            console.error(`ERROR: FAILED CLOSE. Rotating endpoint: ${e.toString()}`)
            //this.ethService.rotateToNextEndpoint()
            this.rotateToNextProvider()
            // one last try....
            await this.closePosition(mkt.wallet, mkt.baseToken, undefined,undefined,undefined)
            console.log("RECOVERY: closed after rotation")
            throw e  
    }
 }

 async close(mkt: Market) {
    if (config.DEBUG_FLAG) {
        console.log("DEBUG: close: " + mkt.name)
        return
    }
    try {
        await this.closePosition(mkt.wallet, mkt.baseToken, undefined,undefined,undefined)
        //bookeeping: upd startCollateral to settled and save old one in basisCollateral
        let scoll = (await this.perpService.getAccountValue(mkt.wallet.address)).toNumber()
        mkt.basisCollateral = scoll
        mkt.startCollateral = scoll
        }
    catch (e: any) {
            console.error(`ERROR: FAILED CLOSE. Rotating endpoint: ${e.toString()}`)
            //this.ethService.rotateToNextEndpoint()
            this.rotateToNextProvider()
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

// report to run onProcessExit
BKPenTWreport() {
    for (const m in this.marketMap) {
        let mkt = this.marketMap[m]
    }
    // open a file for writing  
    let twrstrm = fs.createWriteStream('twreport.csv');
    // write headerr
    twrstrm.
    write(`name, startCollat, endCollat, isSettled\n`);
    // write data
//    Object.values(this.marketMap).forEach(m => {
    for(const m of Object.values(this.marketMap)) {
        let isSettled = m.startCollateral == m.basisCollateral ? "true" : "false"
        twrstrm.write(`${m.name}, ${m.initCollateral}, ${m.basisCollateral}, ${isSettled}\n`)
    }
    twrstrm.end()
 }

 

 genTWreport() {
    const writeStream = fs.createWriteStream('twreport.csv');
    writeStream.write(`name, startCollat, endCollat, isSettled\n`);
  
    for (const m of Object.values(this.marketMap)) {
      const isSettled = m.startCollateral === m.basisCollateral ? "true" : "false";
      writeStream.write(`${m.name}, ${m.startCollateral}, ${m.basisCollateral}, ${isSettled}\n`);
    }
  
    writeStream.on('finish', () => {
      console.log('Report written successfully.');
      process.exit(0);
    });
  
    writeStream.on('error', (err) => {
      console.error(`Failed to write report: ${err}`);
      process.exit(1);
    });
  
    writeStream.end();
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
    // lock to prevent multiple restarts
    
    if (market.rollEndLock || twin.rollEndLock) {
        //console.log("rollEnd already running. exiting")
        return check; // exit if already running
    }
    market.rollEndLock = true;
    twin.rollEndLock = true;
    //console.log("RollEndLocked")
 
    // dont rely on active. probably should remove pay the price for a single read in lieu of gas wasted and complexity
    let pos = (await this.perpService.getTotalPositionValue(mkt.wallet.address, mkt.baseToken)).toNumber()
    let twinpos = (await this.perpService.getTotalPositionValue(twin.wallet.address, twin.baseToken)).toNumber()

    if (!pos && !twinpos ) {
        let tstmp = new Date().toLocaleTimeString([], {hour12: false});
        // note. onClose startCollateral has the settled collateral after close settled
        console.log(tstmp + ": INFO: ROLL.END[" + market.name + "] Coll: " + mkt.startCollateral + ", " + twin.startCollateral)
        check = true
    }
    return check
}
//----------------------------------
// mktDirection
//----------------------------------
BKPDirectionChangeCheck():  boolean {
   // guesstimate mkt direction using btc-eth as a proxy. if dont have prvTick for either, cant guess direction
   if (this.poolState["vETH"].prevTick == 0 || this.poolState["vBTC"].prevTick == 0) { return false }

   let ethd = this.poolState["vETH"].tick!-this.poolState["vETH"].prevTick!
   let btcd = this.poolState["vBTC"].tick!-this.poolState["vBTC"].prevTick!
   // if ethd and btcd dont have the same sign, no guess exit
   if (ethd * btcd < 0) { return false }

   //let dir: Direction = Direction.ZEBRA
   let dir = this.holosSide
  // if both deltas are positive and each > TP_DIR_MIN_TICK_DELTA return TORO
   if ( (ethd > 0) && (btcd > 0) && (ethd > config.TP_DIR_MIN_TICK_DELTA) && (btcd > config.TP_DIR_MIN_TICK_DELTA) ) {
       this.prevHolsSide = this.holosSide
       this.holosSide = Direction.TORO
       let tmstmp = new Date().toLocaleTimeString("en-US", {timeZone: "America/New_York", hour12: false});
       console.log(tmstmp + ": INFO: ethbit Dticks: " + ethd + ", " + btcd)
       return true
   }
   // if both are negative and absolute value of each > TP_MIN_TICK_DELTA then BEAR
   else if ( (ethd < 0) && (btcd < 0) && (Math.abs(ethd) > config.TP_DIR_MIN_TICK_DELTA)
                                      && (Math.abs(btcd) > config.TP_DIR_MIN_TICK_DELTA) ) {
       this.prevHolsSide = this.holosSide
       this.holosSide = Direction.BEAR
       let tmstmp = new Date().toLocaleTimeString("en-US", {timeZone: "America/New_York", hour12: false});
       console.log(tmstmp + ": INFO: ethbit Dticks: " + ethd + ", " + btcd)
       return true
   }
   return false
}

// determine from beth mkt direction. input poolData from updatePoolData 
// cmp unpacking date to current cycle for both to det if this data
mktDirectionChangeCheck():  boolean {
    // wait until vETH and vBTC have data. usint timestamp as flag
    if (!this.poolData["vETH"].lastRecord.timestamp || !this.poolData["vBTC"].lastRecord.timestamp) { return false }
    // time thres to determine if old. if not from this past cycle, exit
    let tthres = Date.now() - config.PRICE_CHECK_INTERVAL_SEC*1000
    if (this.poolData["vETH"].lastRecord.timestamp < tthres || this.poolData["vBTC"].lastRecord.timestamp < tthres) { return false }
    // if delta not same direction, exit
    let ethDelta = this.poolData["vETH"].currTickDelta
    let btchDelta = this.poolData["vBTC"].currTickDelta
    // both proxis must move in same direction for us to care
    if(ethDelta * btchDelta <= 0) { return false }

    // guesstimate direct   
   let dir = this.holosSide
  // if both deltas are positive and each > TP_DIR_MIN_TICK_DELTA return TORO
   if ( (ethDelta > 0) && (btchDelta > 0) && (ethDelta > config.TP_DIR_MIN_TICK_DELTA) 
                       && (btchDelta > config.TP_DIR_MIN_TICK_DELTA) ) {
       this.prevHolsSide = this.holosSide
       this.holosSide = Direction.TORO
       let tmstmp = new Date().toLocaleTimeString("en-US", {timeZone: "America/New_York", hour12: false});
       console.log(tmstmp + ": INFO: ethbit Dticks: " + ethDelta + ", " + btchDelta)
       return true
   }
   // if both are negative and absolute value of each > TP_MIN_TICK_DELTA then BEAR
   else if ( (ethDelta < 0) && (btchDelta < 0) && (Math.abs(ethDelta) > config.TP_DIR_MIN_TICK_DELTA)
                                      && (Math.abs(btchDelta) > config.TP_DIR_MIN_TICK_DELTA) ) {
       this.prevHolsSide = this.holosSide
       this.holosSide = Direction.BEAR
       let tmstmp = new Date().toLocaleTimeString("en-US", {timeZone: "America/New_York", hour12: false});
       console.log(tmstmp + ": INFO: ethbit Dticks: " + ethDelta + ", " + btchDelta)
       return true
   }
   return false
}
//----------------------------------
// wakeUpCheck
//-----
async wakeUpCheck(mkt: Market): Promise<boolean> { 
    // get the tick delta for this market 
    let tickDelta = 0
    //let pool = this.poolState[mkt.tkr]
    let pooldata = this.poolData[mkt.tkr]
    tickDelta = pooldata.currTickDelta - pooldata.prevTickDelta
    if ( tickDelta == 0) { return false }

  // wake up long/short on tick inc
    let dir = this.holosSide
    if ( (mkt.side == Side.LONG) && (tickDelta > mkt.longEntryTickDelta) && (dir == Direction.TORO) ) {
        let pos = (await this.perpService.getTotalPositionValue(mkt.wallet.address, mkt.baseToken)).toNumber()
        let sz = mkt.startCollateral / mkt.resetMargin
        try { 
            if(!pos) { 
                await this.open(mkt,sz)
                let tstmp = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
                console.log(tstmp + " INFO: WAKEUP:" + mkt.name + " Dt:" + tickDelta)
                return true
             } 
        }
        catch(err) { console.error("OPEN FAILED in wakeUpCheck") }
    }
    else if ( (mkt.side == Side.SHORT) && (tickDelta < 0) && (Math.abs(tickDelta) > mkt.shortEntryTickDelta) 
                                       && (dir == Direction.BEAR)) {
        let pos = (await this.perpService.getTotalPositionValue(mkt.wallet.address, mkt.baseToken)).toNumber()
        let sz = mkt.startCollateral / mkt.resetMargin
        try {
            if(!pos) {
                await this.open(mkt,sz)
                let tstmp = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
                console.log(tstmp + " INFO: WAKEUP:" + mkt.name + " Dt:" + tickDelta)
                return true
            }
        }
        catch(err) { console.error("OPEN FAILED in wakeUpCheck") }
    }

    if (tickDelta) {
        console.log("tickDelta:" + mkt.name + ": " + tickDelta)
    }

    return false
}

//----------------------------------
// trigger: roll ended
// if sideless open both sides (twins). else only the favored side of the twins
// ASSERT this.leg and twin have no position
/*
async rollEndCheck(market: Market): Promise<boolean> { 
// check first if this check running for this mkt
let check = false
let leg = this.marketMap[market.name]
let twin = this.marketMap[market.twin]

if (leg.rollEndLock || twin.rollEndLock) {
    //console.log("rollEnd already running. exiting")
    return false; // exit if already running
}

// first run. lock
leg.rollEndLock = true;
twin.rollEndLock = true;
//console.log("RollEndLocked")

// dont rely on active. probably should remove pay the price for a single read in lieu of gas wasted and complexity
let pos = (await this.perpService.getTotalPositionValue(leg.wallet.address, leg.baseToken)).toNumber()
let twinpos = (await this.perpService.getTotalPositionValue(twin.wallet.address, twin.baseToken)).toNumber()

// if both are not closed. nothing to do 
if (pos || twinpos ) {
    // roll did not end. unlock and then exit
    leg.rollEndLock = false;
    twin.rollEndLock = false;
    return false
}
// OK. both legs ended
let tstmp = new Date().toLocaleTimeString([], {hour12: false});
// note. onClose startCollateral has the settled collateral after close settled
console.log(tstmp + ": INFO ROLL.END[" + market.name + "] leg-twin col: " + leg.startCollateral + ", " + twin.startCollateral)

// Decide if one or two legs need to be opened

    let sz = leg.startCollateral * leg.leverage
    let sztwin = twin.startCollateral * twin.leverage
       
    // we should not have any position. but dlbcheck before opening
    //let posv = (await this.perpService.getTotalPositionValue(leg.wallet.address, leg.baseToken)).toNumber()
    //let twinposv = (await this.perpService.getTotalPositionValue(twin.wallet.address, leg.baseToken)).toNumber()    
    
    // ZBR open both
    console.log("INFO: Holos: " + this.holosSide)
    try {
        if (this.holosSide == null ){ // open both. double check not open already!
            if(!pos) {
            await this.open(leg.wallet,leg.baseToken,leg.side,sz)
            }
            if(!twinpos) {
            await this.open(twin.wallet,twin.baseToken,twin.side,sztwin)
        }
        check = true
        }
        else {  // sided market
            let favored = (this.holosSide == leg.side) ? leg : twin
            let szfav = favored.startCollateral * favored.leverage
            // dbl check not open
            let posv = (await this.perpService.getTotalPositionValue(favored.wallet.address, leg.baseToken)).toNumber()
            if(!posv) {
                await this.open(favored.wallet,favored.baseToken,favored.side,szfav)
            }
        check = true
        }
    }
    catch(err) {
        console.error("OPEN FAILED in awakeMktAndOrTwin")
    }
    finally {
    // release lock for this mkt
    leg.rollEndLock = false
    twin.rollEndLock = false
    console.log("EndRoll lock release")
    }
    console.log("UnlockRollEndCheck")
    return  check
}
*/
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
/*
async putWrongSideToSleep() : Promise<Result<boolean>> {
    let check = false
    let errStr = ""
    // only the undead can go to sleep
    let activeMkts = Object.values(this.marketMap).filter(async m => (await this.nonZeroPos(m) == true))
    .map( m => m.name)
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
            }
            catch {
                errStr += "QRM.Close failed:" + n 
            }
            check = true
        }
    return {positive: check, error: Error(errStr) }
}
*/

async prematureSideClose(unfavSide: Side) {
    // group markets by side using position value (pos < 0 is short, 0 is inactive)
    // only the undead can go to sleep

    let nonzeroPos: Market[] = []
    for (const m of Object.values(this.marketMap)) {
        let pos = await this.getPosVal(m)
        if (pos != 0) {
            nonzeroPos.push(m)
        }
    }
    //let nonzeroPos = Object.values(this.marketMap).filter(async m => (await this.getPosVal(m) >  0) || (await this.getPosVal(m) >  0)).map( m => m.name)
    
    // groupby long/short gangs among the actives
    const longShortGang = nonzeroPos.reduce<{ sgang: Market[], lgang: Market[] }>
                    ((grps, item) => { item.name.endsWith("SHORT") ? grps.sgang.push(item) : grps.lgang.push(item);
                                      return grps; }, 
                                      { sgang: [], lgang: [] })
    // put on death row mkts in the 'wrong' side. side was updated in oneSidedMarketSwitch 
    // if direction is TORO then put on death row the shorts 
    //let markedSide = (unfavSide == Direction.TORO) ? Side.LONG : Side.SHORT                   
    let deathrow = (unfavSide == Side.LONG) ? longShortGang.lgang : longShortGang.sgang
    // spare the good performers in the losing gang
    let pardonned = Object.values(deathrow).filter((n) => 
                    n.basisCollateral / n.startCollateral > config.TP_MIN_PARDON_RATIO )
    let toExecute = deathrow.filter( (n) => !pardonned.includes(n) )
    // cull the undesirebles
    if(toExecute.length)
        for (const m of deathrow ) {
//            const n = this.marketMap[m].name
            try {
                await this.close(m)
                // this.close will take care of updating start/basisCollat 
            }
            catch { 
                "QRM.Close failed:" + m.name
            }
        }
}

// DESC: flags if regime switch to one sided (bull or bear) really is a Participation signal
// uret < TP_QRM_MIN_RET. this value SHOULD be higher than TP_MAX_LOSS_RATIO e.g if maxloss is 91 
// MIN RATIO would be something like 92 
// regime switch is based on qurom on BOTH active/inactive mkts with a minum number of long/short
// required e.g for 2/3 then 5 modulus 2*5/3 => 2 for 6  => modulus 2*6/3 = 4
// TODO. should incorporate duration to be sqr adjusted to 200 ticks/15 seq to a TP_DURATION (30 minute?)
// ASSERT TP_MIN_COL_RATIO > TP_MAX_LOSS
// Critera for regime switch: collateral/startCollateral == MaxLoss collateral ratio
// Criterial can be cusotmizez
/*
async oneSidedTransitionCheck() :Promise<boolean> {
    // true only if mkt switch from null to one sided OR sides flipped e.g from rally to bear
    let check = false
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
        let longBigLosers = longShortGrp.longGang.filter( n => this.marketMap[n].uret < config.TP_QRM_MIN_RET )
        //        ( n => this.marketMap[n].basisCollateral/this.marketMap[n].startCollateral < config.TP_MIN_COL_RATIO )
        let shortBigLosers = longShortGrp.shortGang.filter( n => this.marketMap[n].uret < config.TP_QRM_MIN_RET )
        //         ( n => this.marketMap[n].basisCollateral/this.marketMap[n].startCollateral < config.TP_MIN_COL_RATIO ) 
        //Lets find the biggest losser
        let lgangScore = longBigLosers.length
        let sgangScore = shortBigLosers.length 
        // infer which animal is likely to be roaming
        let currInferance = undefined
        if (lgangScore >= minQrmCount && sgangScore < minQrmCount) {
            currInferance = BEAR
        }
        else if (sgangScore >= minQrmCount && lgangScore < minQrmCount) {
            currInferance = BULL
        }
        else { // we have a zebra
            currInferance = null
        }
        // did the env change to a diff non-zebra. ie nothing to do if zbra aka lowest participation
        if (!currInferance && (currInferance != this.holosSide )){
            check = true
            this.prevHolsSide = this.holosSide //save before overwrite
            this.holosSide = currInferance
            let tstmp = new Date().toLocaleTimeString([], {hour12: false});
            console.log(tstmp + ": INFO: RegimeSwitch:" + this.holosSide)
        }

        return check
}  
*/
async putMktToSleep(mkt: Market) {
    try {
        await this.close(mkt) 
    }
    catch(err) {
        console.error("Failed closed in putMktToSleep")
    }
         let oldStartCol = mkt.basisCollateral
            let settledCol = mkt.startCollateral //updated in this.close
            let ret = 1 + (settledCol-oldStartCol)/oldStartCol
            let tstmp = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
    console.log(tstmp + ": INFO: Kill " + mkt.name + ", stldcoll: " + settledCol.toFixed(4) + " rret: " + ret.toFixed(2))
}

async holosCheck() :Promise<boolean> {
// compute poolState tick changes segragating positive vs negative
this.poolState

    return false
}
//----------------------------------------------------------------------------------------------------------
// this check also update state: peak and uret
// COND-ACT: on TP_MAX_LOSS close leg. When twin MAX_LOSS (pexit) rollStateCheck will restart
// SIDEff: mkt.startCollatera onClose and also on new peak
// Error: throws open/close
// NOTE: when dado is stopped 
//----------------------------------

async legMaxLossCheckAndStateUpd(mkt: Market): Promise<boolean> {
    // skip if market inactive
    let check = false
    let leg = this.marketMap[mkt.name]
    if (await this.nonZeroPos(leg)) { 
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
        // update uret used by qrom holos check
        mkt.uret = uret
        console.log(mkt.name + " cbasis:" + mkt.basisCollateral.toFixed(2) + " uret:" + uret.toFixed(4))
    } 
    /*dump ticks output for display
    let dltatick = this.poolStateMap[mkt.tkr].tick! - this.poolStateMap[mkt.tkr].prevTick!
    if (dltatick != 0) {
        console.log(mkt.name + " dtks:" + dltatick ) 
    }*/
    return check 
  }

// FIXME: use the new way >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

async maxMaxMarginRatioCheck(market: Market) {
    // current marginratio = collat+upnl/positionVal. note collat + upnl == basisCollateral
    let pv = (await this.perpService.getTotalAbsPositionValue(market.wallet.address)).toNumber()
    let tick = this.poolState[market.tkr].tick
    // skip if no position
    if (pv == 0 || tick == 0) return
    let mr = market.basisCollateral/pv
    if (mr > market.maxMarginRatio ){
    // compute additional size to bring down the margin ratio to reset value
    // mr = (collatBasis)/positionValue=positionSize*price => positionSize = collatBasis/price*mr
    
    let tickPrice = Math.pow(1.0001, tick!)
    let idxPrice = (await this.perpService.getIndexPrice(market.tkr)).toNumber()
    let mktPrice = (await this.perpService.getMarketPrice(market.tkr)).toNumber()

    // tick price results in mr higher than reset. go for lowest price
    let price = Math.min(tickPrice, idxPrice, mktPrice)

    let sz  = market.basisCollateral/price*market.resetMargin
    // add to the position and recompute margin ratio
    await this.open(market, sz*price)

    pv = (await this.perpService.getTotalAbsPositionValue(market.wallet.address)).toNumber()
    let newmr = market.basisCollateral/pv
    let tmstmp = new Date().toLocaleTimeString([], {hour12: false, timeZone: 'America/New_York'});
    console.log(tmstmp + " INFO: tick, indx, market Price: " + tickPrice + " " + idxPrice + " " + mktPrice)
    console.log(" INFO: MARGIN RESET: " + market.name + " prv mr:" + mr.toFixed() + " nu mr:" + newmr.toFixed() + " sz:" + sz)
    }
}
//--------------------------------------------------------------------------------------
// TODO: factor out this check from of here
//--------------------------------------------------------------------------------------
async ensureSwapListenersOK(): Promise<void> {
    // just need to check any one pool if the listener not there probably not for all and reinstall
    // TODO. do also a check if csv has not been updated?
    const testPool = this.poolState['vSOL'].poolContract;
    const swapListenerCount = await testPool.listenerCount('Swap');
    if (swapListenerCount === 0) {
        this.setupPoolListeners();
        console.log('INFO: Swap listeners reinstalled');
    }
  }
  
//  mainRoutine
// TODO: OPTIMIZE: batch all checks for all legs. can avoid unnecessary checks e.g if SHORT leg above threshold twin will not
//--------------------------------------------------------------------------------------
  async checksRoutine(market: Market) {
    //TODO.BIZCONT redo ensureSwapListenersOK, it will always return listerneCounter of zero coz new instance
    await this.ensureSwapListenersOK()
    // first things first.check for TP_MAX_LOSS
    if ( await this.legMaxLossCheckAndStateUpd(market) ) {   // have a positive => close took place. check for qrom crossing
        this.putMktToSleep(market)
    }
    //updat pool data
    this.updatePoolData()
    this.mktDirectionChangeCheck()
    // check for direciton. updates this.Direction
    
    /* holos close check
    if ( await this.holosDirectionChangeCheck() ) {   
            // unfav is shorts in a toro and longs in a bear
            let unfav =  (this.holosSide == Direction.TORO ? Side.SHORT : Side.LONG)
            this.prematureSideClose(unfav)
    }
    */
    // MMR. maximum margin RESET check
    await this.maxMaxMarginRatioCheck(market)
    
    // selective wake up
    await this.wakeUpCheck(market) //wakeup only favored leg if sided mkt else both
  }
    
    // check if there is a direction change into a non-zebra beast
    async holosDirectionChangeCheck(): Promise<boolean> {
        // which pools have moved at least say 10 ticks to ignore noise
        const minMoveList = Object.values(this.poolState).filter(
            (pool) =>( Math.abs(pool.tick! - pool.prevTick!) > config.TP_QROM_ABS_TICK_SZ )
                      && (pool.prevTick!) != 0 )
            // segregate positive and negative moves
        if (minMoveList.length) {
          const posPools = minMoveList.filter((pool) => pool.tick! - pool.prevTick! > 0
          );
          const negPools = minMoveList.filter((poolState) => poolState.tick! - poolState.prevTick! < 0
          );
          
          // update direction if meets threadhold
          let currDir
          let count = Object.keys(this.poolState).length
          if ((posPools.length / count > config.TP_QRM_DIR_CHANGE_MIN_PCT)  && 
              (negPools.length / count < config.TP_QRM_DIR_CHANGE_MIN_PCT)) {
                currDir = Direction.TORO;
          } 
          if ((negPools.length / count > config.TP_QRM_DIR_CHANGE_MIN_PCT)  && 
              (posPools.length / count < config.TP_QRM_DIR_CHANGE_MIN_PCT)) {
                currDir = Direction.BEAR;
          } 
          if ((this.prevHolsSide !== currDir) && (currDir === Direction.TORO || currDir === Direction.BEAR)) {
            // update direction and return true
            this.prevHolsSide = this.holosSide //save before overwrite
            this.holosSide = currDir
            return true
          }
        } 

        return false
    }
/* HIDE 
    async arbitrage(market: Market) {
            if ( await this.legMaxLossCheckAndStateUpd(market) ) {   // have a positive => close took place. check for qrom crossing
                this.putMktToSleep(market)
            }
            // REFAC regimeSwitchOnCollat(criteria =RatioTest)
            if (await this.oneSidedTransitionCheck() ) {   // swith from (ZBR to bull/bear OR bull<->bear)
                await this.putWrongSideToSleep()        // all active lgang or sgang. unless winner among losers
            }
            // ROLL.END.Condition: (!mkt.active &&  !mk.twin.active)
            //if (await this.rollEndTest(market)) {
            await this.rollEndCheck(market) //wakeup only favored leg if sided mkt else both
     }
 
       
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