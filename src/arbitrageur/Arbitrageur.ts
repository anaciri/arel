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
import { time, timeStamp } from "console"
import { Interface } from "readline"
//import { IUniswapV3PoolEvents } from "@perp/IUniswapV3PoolEvents";
import IUniswapV3PoolABI from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { Block, StaticJsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { Mutex } from "async-mutex";
import { checkServerIdentity } from "tls"
import { dbgnow } from "../dbg/crocDebug"

let dbgcTicks: TickData[] = []; // declare variable outside if statement
let dbgmTicks: TickData[] = [];

if (config.DEBUG_FLAG) {
    import('../dbg/crocDebug').then(module => {
        dbgcTicks = module.cticks; // assign the imported `ticks` array to the variable
        dbgmTicks = module.mticks;
    });
}

type Timestamp = number;
type Tick = number;

interface TickData {
  timestamp: Timestamp;
  tick: Tick;
}

class CircularBuffer {
  private readonly buffer: TickData[];
  private readonly capacity: number;
  private readonly lock: Mutex;

  constructor(capacity: number) {
    this.buffer = [];
    this.capacity = capacity;
    this.lock = new Mutex();
  }

  public add(timestamp: Timestamp, tick: Tick): void {
    this.lock.acquire();
    this.buffer.push({ timestamp, tick });
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
    this.lock.release();
  }

  public getLatest(): TickData {
    this.lock.acquire();
    const latest = this.buffer[this.buffer.length - 1];
    this.lock.release();
    return latest || { timestamp: 0, tick: 0 };
  }

  public getAll(): TickData[] {
    this.lock.acquire();
    const copy = [...this.buffer];
    this.lock.release();
    return copy;
  }

  public getDataAt(timestamp: Timestamp): TickData[] {
    this.lock.acquire();
    const data: TickData[] = [];
    for (const item of this.buffer) {
      if (item.timestamp >= timestamp) {
        data.push(item);
      }
    }
    this.lock.release();
    return data;
  }

  public hasWrapped(): boolean {
    this.lock.acquire();
    const first = this.buffer[0];
    const last = this.buffer[this.buffer.length - 1];
    this.lock.release();
    return last !== undefined && first !== undefined && last.timestamp < first.timestamp;
  }

  public getLength(): number {
    this.lock.acquire();
    const length = this.buffer.length;
    this.lock.release();
    return length;
  }
}


require('dotenv').config();
//const CAP_EDGE_TICKERS = ["vSOL", "vPERP", "vFLOW", "vNEAR", "vFTM", "vAPE", "vAAVE"]
const CAP_EDGE_TICKERS = ["vSOL", "vPERP", "vFLOW", "vAAVE"]

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
    tick: number
  };

type CumulativeTick = {
    refCumTickTimestamp: number;
    refCumTick: number // acc of last 15sec perp cap timeslot
    prevRefCumTick: number // previous acc of last 15sec perp cap timeslot
    currCumTick: number // current running accum running every tulut cycle
  };
// low level poolData only intended for event handlers and eventInput processor
interface PoolData {
    //lastRecord: TickRecord 
    inBuffer: CircularBuffer[]
    bucket: TickRecord[] //TO REMOVE: timestamp, tick raw
    //currTickDelta: number, //latest delta computed by updatePoolData
    //prevTickDelta: number, //previou delta saved by updatePoolData
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
    cycleTickDeltaTs: number
    cycleTickDelta: number // cycle_wpx - memory_wpx typically 1 min cycle/30 min memory
    poolAddr: string,
    bucket: TickRecord[],
    tick: number | undefined,
    prevTick: number | undefined,
    poolContract: UniswapV3Pool,
    cumulativeTick: CumulativeTick | null, // time interval determine by PM_CUM_TICK_INTERVAL default 1 second
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
    startSize: number | null // initialized on first open and nulled on close
    openMark: number | null // mark at open
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

    private tickBuff: { [ticker: string]: PoolData } = {} // TO DEPRECATE
    private evtSubProviderEndpoints: string[] = []
    private evtSubEndpointsIndex: number = 0
    private evtSubProvider!: StaticJsonRpcProvider | WebSocketProvider;
    private evtBuffer: { [key: string]: CircularBuffer } = {};
    //convinienc list of enbled market
    enabledMarkets: string[] =[]
    

    

    async setup(): Promise<void> {
        
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
        // initialize data structures needed for evt buffering and processing i.e evtBuffer and PoolState
        // 1. get enabled markets from config
        await this.createMarketMap()
        // 2. allocate memory for evtBuffers for enabled tickers
        this.initDataStructs()
        this.createPoolStateMap() //<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<--- rename to initDataStruc

        //this.createPoolDataMap()

        this.evtSubProviderEndpoints = process.env.EVENT_SUB_ENDPOINTS!.split(",");
        if (!this.evtSubProviderEndpoints) { throw new Error("NO Subscription Providers in .env")}
        else { 
            this.evtSubProvider = new ethers.providers.JsonRpcProvider(this.evtSubProviderEndpoints[this.evtSubEndpointsIndex]);
        }
        await this.setupPoolListeners()
        /*/ move this to checker
        const proxies = ["vBTC", "vETH", "vBNB"]
        for (const tkr of proxies) {
            let subs = this.poolState[tkr].poolContract.filters.Swap()
            console.log("SETUP: proxy topics " + tkr + ": " + subs.topics)
        }*/
        
        console.log("CROC: EvtSubProv: " + this.evtSubProvider.connection.url)
        
        // DEBUG snippet ------------------------------------------
        //this.dbgSnip()

    }
//---------------------------------------- SNIP DBG
    dbgSnip() {
        let ct = dbgcTicks
        let mt = dbgmTicks

        let now = dbgnow

        let tkr = "vAAVE"
        const cutoff = now - config.PRICE_CHECK_INTERVAL_SEC * 1000;
        const cticks = Object.values(ct);
    const cweights = cticks.map((tick, i) => i + 1);
    const wtick = this.computeWeightedArithAvrg(cticks, cweights);

    // compute lastThirtyMinutes-memory (excluding the last cycle values)
    const lastThirtyMinutesStart = cutoff - 30 * 60 * 1000;
    const lastThirtyMinutesData = dbgmTicks;
    // compute lastThirtyMinutes (excluding the last cycle values)
    lastThirtyMinutesData.splice(-cticks.length);

    // compute the weighted arithmetic mean for the last thirty minutes
    const buffvals = Object.values(lastThirtyMinutesData);
    const bweights = buffvals.map((tick, i) => i + 1);
    const tickBasis = this.computeWeightedArithAvrg(buffvals, bweights);

    // update cycleDelta for each pool. consumed by mktDirection and soon maxloss
    this.poolState[tkr].cycleTickDelta = wtick - tickBasis;

    // check for discontinuity of events by comparing in the circular buffer age of the last buffer entry
    const age = now - this.evtBuffer[tkr].getLatest().timestamp
    if ( age > config.MON_MAX_TIME_WITH_NO_EVENTS_SEC * 1000 ) { 
        console.log( Date.now() + " MONITOR: " + tkr + ": No events in " + (age/60000).toFixed() + " mins")
        
        // if too long and proxy ticker rotate provider to be safe
        if ( tkr in ["vBTC", "vETH", "vBNB"]){
            console.log( Date.now() + " MONITOR: Rotate on account of Max delay of" + tkr )
            this.rotateEvtSubProvider()
        }
    }


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

  
    //--------------------------------------------------------------------------------
    // setup listeners for all pools
    // responsable to update the poolData.tickLog used in updatePoolData to compute the cumulative tick changes
    // TODO: move poolContractAddr to PoolData
    //--------------------------------------------------------------------------------
 

    // fill inbuff with ticks into circular buffer of at least 30 minutes capacity. may get multiple ticks 
    // in same second and then go 30 minutes without ticks. size of 400 should be enough
    // processInputBuff reads syncronously from inbuff and writes to outbuff 

    async BKPsetupPoolListeners(): Promise<void> {
        //for (const p of this.perpService.metadata.pools) {
        // read subscription provider from env file
        const currUrl = this.evtSubProviderEndpoints[this.evtSubEndpointsIndex];

        for (const tkr in this.poolState) {
            const unipool = new ethers.Contract( this.poolState[tkr].poolAddr, IUniswapV3PoolABI.abi, this.evtSubProvider)

            //let unipool = this.poolState[tkr].poolContract
            
            // setup Swap event handler
            unipool.on('Swap', (sender: string, recipient: string, amount0: Big, amount1: Big, sqrtPriceX96: Big, 
                                liquidity: Big, tick: number, event: ethers.Event) =>
                        { // Fill the bucket until the flags changes to read
                            const timestamp = Math.floor(Date.now())
                            this.tickBuff[tkr].bucket.push({ timestamp: timestamp, tick: tick})
                            // if data has been read then empty tickLog
                            //>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
                            if (this.tickBuff[tkr].isRead == true) {
                                // keep the last tick as reference
                                this.tickBuff[tkr].bucket.splice(0, this.tickBuff[tkr].bucket.length - 1);
                                this.tickBuff[tkr].bucket.pop()
                                this.tickBuff[tkr].isRead = false
                            }
                        // heartbeat
                        //console.log(`HEARTBEAT: ${timestamp}, ${symb}`)    
                        })
        }   
    }

    async setupPoolListeners(): Promise<void> {
        //for (const p of this.perpService.metadata.pools) {
        // read subscription provider from env file
        const currUrl = this.evtSubProviderEndpoints[this.evtSubEndpointsIndex];

        for (const tkr of this.enabledMarkets) {
            const unipool = new ethers.Contract( this.poolState[tkr].poolAddr, IUniswapV3PoolABI.abi, this.evtSubProvider)

            //let unipool = this.poolState[tkr].poolContract
            
            // setup Swap event handler
            unipool.on('Swap', (sender: string, recipient: string, amount0: Big, amount1: Big, sqrtPriceX96: Big, 
                                liquidity: Big, tick: number, event: ethers.Event) =>
                        { // Fill the bucket until the flags changes to read
                            const timestamp = Math.floor(Date.now())
                            this.evtBuffer[tkr].add(timestamp, tick)
if (config.TRACE_FLAG) { console.log(" TRACE: evt: " + tkr  + " " + timestamp + " " + tick) }
                        })
        }   
    }

 initDataStructs() {
    // capacity should be enought to handle multiple entries in same seconds for a whole cycle
    const bufferCapacity = config.DS_EVT_CIRCULAR_BUFF_CAPACITY;
    const marketKeys = Object.keys(this.marketMap);

    for (const key of marketKeys) {
        const tkr = this.marketMap[key].tkr;
        this.evtBuffer[tkr] = new CircularBuffer(bufferCapacity);
    }
}
  
    createPoolStateMap() {
        for (const pool of this.perpService.metadata.pools) {
            if (this.enabledMarkets.includes(pool.baseSymbol)) {
                const poolContract = this.perpService.createPool(pool.address)

                this.poolState[pool.baseSymbol] = { 
                cycleTickDelta: 0,
                cycleTickDeltaTs: 0,
                bucket:[], // DEPRECATED use this.evtBuff
                poolAddr: pool.address,
                poolContract: poolContract,
                tick:0,  // otherwise wakeup check will choke
                prevTick: undefined,
                cumulativeTick: null,
              };
            }
        }
    }

    /*/ init PoolData for all pools
    createPoolDataMap() {
        for (const pool of this.perpService.metadata.pools) {
          this.tickBuff[pool.baseSymbol] = { 
            //lastRecord: {tick: 0, timestamp: 0},
            bucket: [],
//            prevTickDelta: 0,
            //currTickDelta: 0,
            isRead: false,
          };
        }
      }*/

   async createMarketMap() {
        const poolMap: { [keys: string]: any } = {}
        for (const pool of this.perpService.metadata.pools) { poolMap[pool.baseSymbol] = pool }
        for (const [marketName, market] of Object.entries(config.MARKET_MAP)) {
            if (!market.IS_ENABLED) { continue }
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
                openMark:null,
                startSize:null,
                cummulativeLoss: 0,
                maxPnl: 0,
                //notionalBasis: config.TP_START_CAP/market.RESET_MARGIN,
                //TODO.rmv
                rollEndLock:false,
                resetNeeded: false,
                resetSize:0,
                twin: marketName.endsWith("SHORT") ? marketName.split("_")[0] : marketName + "_SHORT"
            }
            // populate convinience property
            this.enabledMarkets.push( marketName.split('_')[0] )
        }
        // remove duplicates from enabledMarkets (i.e vSOL/and vSOL_SHORT)
        this.enabledMarkets = [...new Set(this.enabledMarkets)];
    }
    
    async start(): Promise<void> {
        //TODO.BIZCONT renable rotation to do the health checks
        this.ethService.enableEndpointRotation()
        await this.arbitrageRoutine()
        //await Promise.all([this.arbitrageRoutine(), this.tulutRoutine()]);
    }
/*
    // check if INTRA perp cap timeslot 15 sec breached TP_MIN_TICK_DELTA
    capEdgeCheck() {
        loop (CAP_EDGE_TICKERS)
        if tulutCounter < 4 and cummulativeFifteenSec - runningCummulative2second > TP_MIN_TICK_DELTA
           open position 
           if cummulativeFifteenSec - runningCummulative2second > 100 dump buffer for analysis as log.err coz should not be here
     }
     */
    async tulutRoutine() {
        // list of tickers to monitor vSOL, vPERP, vFLOW and vAAVE
        
        //const TT_INTERVAL_SEC  = 3 // 15 sec /5 = 3 sec
        
        const TT_ROUTINE_SLEEP_SEC = 3 // must be smaller or equal to TT_INTERVAL_SEC
        // update cummulative prices
        this.pxAccumUpdate()
        // check if crossed entry threshold
        for (const tkr of CAP_EDGE_TICKERS) {
            let mkt = this.marketMap[tkr]
            let accpx = this.poolState[mkt.tkr].cumulativeTick
            // if cummulativeFifteenSec cross threshold open
            if (!accpx) { continue }
            //TODO.HEALTHCHECK if tkr not initialized
            let tickdlta = Math.abs(accpx.currCumTick - accpx.refCumTick) 
            if ( tickdlta > this.marketMap[tkr].longEntryTickDelta) {
                 try {
                    //TODO: this.openPosition(mkt) 
                 } catch (e) { 
                    console.error(tkr + ": ERR: failed to open in pxAccumUpdate")
                 }
                // if cummulativeFifteenSec - runningCummulative2second > 100 dump buffer for analysis as log.err coz should not be here
                if (tickdlta > config.DA_DUMP_MIN_TICK_DLTA) {
                    // dump buffer for analysis as log.err coz should not be here
                }
            }
        }
        await new Promise(resolve => setTimeout(resolve, TT_ROUTINE_SLEEP_SEC * 1000))
    }

 pxAccumUpdate() {      
    const TT_PERP_PCAP_INTERVAL_SEC = 15 // perp 15 sec time to xceed the 250 tics  
    // are we at the end of the TT_PERP_PCAP_INTERVAL_SEC. compare ts
    let now = Math.floor(Date.now());
    for (const tkr of CAP_EDGE_TICKERS) {
        let mkt = this.marketMap[tkr]
        let accpx = this.poolState[mkt.tkr].cumulativeTick
        // if first time initialize
        if ( !accpx ) {
            // do we have any ticks to initialize. if not wait for next time
            
            if (this.tickBuff[tkr].bucket.length == 0) { continue }
            // reduce ticks in tickBuff to get the cummulative tick
            const cumtick = this.tickBuff[tkr].bucket.reduce( 
                (accumulator, tickRecord) => {
                    if (tickRecord.tick !== null) { return accumulator + tickRecord.tick }
                    return accumulator; }, 0)

            let acct = {
                refCumTickTimestamp: now,
                // sum all the ticks in the buffer
                prevRefCumTick: cumtick,
                refCumTick: cumtick,
                currCumTick: cumtick
            }
            this.poolState[mkt.tkr].cumulativeTick = acct
        }
        // has the 15 sec interval passed
        if ( accpx!.refCumTickTimestamp >= now - TT_PERP_PCAP_INTERVAL_SEC) {
            accpx!.prevRefCumTick = accpx!.refCumTick
            accpx!.refCumTick = accpx!.currCumTick
        // current cummulative tick - refTick now is zero
        accpx!.refCumTickTimestamp = now
        this.poolState[mkt.tkr].cumulativeTick = accpx
        }
        else {  
        // not at the end of the 15 sec interval. accumulate the current tick
        let tickBuff = this.tickBuff[tkr].bucket
        // pick up ticks since last cyle
        let reftick = tickBuff.find((tk) => tk.timestamp > now - config.TT_ROUTINE_SLEEP_SEC)
        // if no new ticks nothing to do
        if ( reftick ) { 
            // get all the ticks in tickBuff with timestamp between reftick.timestamp and now
            let tickset = tickBuff.filter((tk) => tk.timestamp >= reftick!.timestamp && tk.timestamp <= now)
            // aggregate all the ticks in tickList
            let tickAccum = 0
            for (const tk of tickset) { tickAccum += tk.tick! }
            this.poolState[mkt.tkr].cumulativeTick!.currCumTick  = this.poolState[mkt.tkr].cumulativeTick!.currCumTick + tickAccum
        }
         }
    }
 }

    async arbitrageRoutine() {
        while (true) {
            //TODO.STK turn on heart beat below
            //this.markRoutineAlive("ArbitrageRoutine")
            await Promise.all(
                Object.values(this.marketMap).map(async market => {
                    try {
                        //await this.arbitrage(market)
                        await this.checksRoutine(market)
                    } catch (err: any) { await this.jerror({ event: "ArbitrageError", params: { err } })
                    }
                }),
            )
            await sleep(config.PRICE_CHECK_INTERVAL_SEC * 1000)
        }
    }

    
//------------------
// updatePoolData() accumulates tick changes for a given TP_TICK_TIME_INTERVAL, needed to gestimate if there is unidirection
 //------------------
 /*
 BKPupdatePoolData(): void {
 for (const symb in this.poolState) {   
    if (this.poolData[symb].bucket.length == 0) { continue }
    if (this.poolData[symb].bucket.length == 0) { 
        console.error(symb + " DEBUG: should not be here" + this.poolData[symb].lastRecord?.tick)
        //victim of race condition. skip and see if next round will work
        continue
    }
    // get tick delta from the tickBuff. Diff btw last and first in the buffer
    const len = this.poolData[symb].bucket.length
    const tickDelta = this.poolData[symb].bucket[len-1].tick! - this.poolData[symb].bucket[0].tick!
    // set flag to let handler to reset tickLog
    
    this.poolData[symb].lastRecord.tick = tickDelta
    this.poolData[symb].lastRecord.timestamp = Date.now()
    //TODO.DEBT HACK work aournd the race condition. wrap in a setter/getter with mutex
    // flag handler that ok to discard current buffer and start a new one (or throw old entries)
    this.poolData[symb].isRead = true

    //this.poolData[symb].prevTickDelta = this.poolData[symb].currTickDelta
    this.poolData[symb].currTickDelta = tickDelta
    
    if (Math.abs(tickDelta) > config.TP_NOISE_MIN_TICK_DLTA) {
        const csvString = `${symb},${Date.now()},${tickDelta}\n`;
        fs.appendFile('tickdelt.csv', csvString, (err) => { if (err) throw err });
    }
 }
}*/

rotateEvtSubProvider() {
    //rotateToNextEndpoint(callback = undefined) {
        this.evtSubProvider.removeAllListeners()
        const fromEndpoint = this.evtSubProviderEndpoints[this.evtSubEndpointsIndex];
        this.evtSubEndpointsIndex = (this.evtSubEndpointsIndex + 1) % this.evtSubProviderEndpoints.length;
        const toEndpoint = this.evtSubProviderEndpoints[this.evtSubEndpointsIndex];
        // reinstall listeners
        this.setupPoolListeners()
        console.warn( Date.now() + " MONITOR: EvtSubProv Rotation from " + fromEndpoint + " to: " + toEndpoint)
}
  

// DEP: poolData filled by eventListener
// health check. 1) check foremost the proxies subscriptions are OK 2) check on the other pools
// detect discontinuity and drain bucket 
// tickBuff is the lowlevel DS using only by eventhandler and this checker that copies it inot statePool
checkOnPoolSubEmptyBucket(): void {
    for (const tkr in this.poolState) {   
        // poll each pool to detect discontinuity and empty bucket
        let ts = Date.now()
        let len = this.tickBuff[tkr].bucket.length
        let bucket = this.tickBuff[tkr].bucket
        if (bucket.length == 0) { console.log(ts + " WARN: empty buckt: " + tkr) ; continue }

        // detect discontinuity of events in poolData
        let age = Date.now() - this.tickBuff[tkr].bucket[len-1].timestamp
        let multiplier = 5 // to reduce noice
        if ( age > multiplier * config.PRICE_CHECK_INTERVAL_SEC*1000 ) { 
            console.log( Date.now() + " MONITOR: " + tkr + ": No events in " + (age/60000).toFixed() + " mins")
            // if mkt is a proxy then if no events for more than CRITICAL time resuscribe
            if (tkr in ["vBTC", "vETH", "vBNB"]) {
                console.warn("WARN: " + tkr + " possible subscription problem. check Proxy subscriptions")
            }
            continue 
        }
        // copy bucket/ will not drain it. need to flag is read
        this.poolState[tkr].bucket = [...this.tickBuff[tkr].bucket]
        this.tickBuff[tkr].isRead = true

        // log last tick value and its timestamp
        const csvString = `${tkr},${this.poolState[tkr].bucket[len-1].timestamp},${this.poolState[tkr].bucket[len-1].tick}\n`;
        fs.appendFile('tickdelt.csv', csvString, (err) => { if (err) throw err });
    }
    // check tail of the file how long since last timestamp
    let csvContents = ''
    try {
        csvContents = fs.readFileSync('tickdelt.csv', 'utf-8')
        const csvRows = csvContents.split('\n');
        const lastRowString = csvRows[csvRows.length - 2]; // Subtract 2 to ignore empty last line

        // Extract the timestamp value from the last row
        const lastRowValues = lastRowString.split(',');
        const ts = parseInt(lastRowValues[1])
        const age = Date.now() - ts
        //if ( (age) > 1000 * config.MON_MAX_TIME_WITH_NO_EVENTS_SEC ){
        if ( (age) > 1000 * config.MON_MAX_TIME_WITH_NO_EVENTS_SEC ){
            this.rotateEvtSubProvider()
        }
    } catch (err: any) {
        if (err.code === 'ENOENT') { console.log('tick csv empty, skipping rotation check.');
        } else { throw err; }
      }
}
// process inbuff produced by eventListener to update cycle tick deltal for enabled markets
// 2. pull last 30 mins of data. xlcuding 1), 1. pull the last cycle seconds of data. 3. if nothing 
// in the last cycle worth, return, 4. if no tick in the 30min buff return, nxt minute for sure will have something
// compute the weighted geometric mean for the rest of the 30 mins this will be the tickbasis
// to compute tick delta change
// TODO: normalize everyting to use returns including thresholds e.g aave 1.3 - 0.7

// responsible with: 1) marking the cycle tick change 2) check on discontinuity of events 3) recording in csv
// mktDirection check uses this deltas to asses conviction. TODO: to replace uret wich uses index price (ipx)
processEventInputs(): void {
  for (const tkr of this.enabledMarkets) {  
    // this processors should allways pull before it wraps around
    if ((this.evtBuffer[tkr]).hasWrapped()) { console.warn("WARN: circular buffer wrapped around for " + tkr) }
    // compute current cyle-weighted-arithmetic-mean px aka wpx
    const now = Date.now();
    const cutoff = now - config.PRICE_CHECK_INTERVAL_SEC * 1000;
    const cyclevals = this.evtBuffer[tkr].getDataAt(cutoff);
    //set cyclevals to dbgTicks in debug
    
    // skip if no data since last cycle. first trace
if( config.TRACE_FLAG) { console.log(now + " TRACE: " + tkr + " cyclevals: " + JSON.stringify(cyclevals)) }
    if (Object.keys(cyclevals).length == 0) { continue }

    // compute the weighted arithmetic mean for the last cycle seconds
    const cticks = Object.values(cyclevals);
    const cweights = cticks.map((tick, i) => i + 1);
    const wtick = this.computeWeightedArithAvrg(cticks, cweights);

    // compute lastThirtyMinutes-memory (excluding the last cycle values)
    // first ensure we have some memory
    if (this.evtBuffer[tkr].getLength() < cyclevals.length + 1) { return }
    const lastThirtyMinutesStart = cutoff - 30 * 60 * 1000;
    const lastThirtyMinutesData = this.evtBuffer[tkr].getDataAt(lastThirtyMinutesStart);
    // compute lastThirtyMinutes (excluding the last cycle values)
    lastThirtyMinutesData.splice(-cticks.length);
if( config.TRACE_FLAG) { console.log(now + " TRACE: " + tkr + " membuff: " + JSON.stringify(lastThirtyMinutesData)) }

    // compute the weighted arithmetic mean for the last thirty minutes
    const buffvals = Object.values(lastThirtyMinutesData);
    const bweights = buffvals.map((tick, i) => i + 1);
    const tickBasis = this.computeWeightedArithAvrg(buffvals, bweights);
if( config.TRACE_FLAG) { console.log(now + " TRACE: " + tkr + " wcycleTicks: " + wtick + " tickBasis: " + tickBasis) }

    // update cycleDelta for each pool. consumed by mktDirection and soon maxloss
    this.poolState[tkr].cycleTickDelta = wtick - tickBasis;
    this.poolState[tkr].cycleTickDeltaTs = cyclevals[cyclevals.length-1].timestamp
if( config.TRACE_FLAG) { console.log(now + " TRACE: " + tkr + " cTkDelta: " + this.poolState[tkr].cycleTickDelta) }
    console.log( Date.now() + " MONITOR: " + tkr + ": cycleTickDelta: " + this.poolState[tkr].cycleTickDelta.toFixed(2) )

    // check for discontinuity of events by comparing in the circular buffer age of the last buffer entry
    const age = now - this.evtBuffer[tkr].getLatest().timestamp
    if ( age > config.MON_MAX_TIME_WITH_NO_EVENTS_SEC * 1000 ) { 
        console.log( now + " MONITOR: " + tkr + ": No events in " + (age/60000).toFixed() + " mins")
        
        // if too long and proxy ticker rotate provider to be safe
        if ( tkr in ["vBTC", "vETH", "vBNB"]){
            console.log( Date.now() + " MONITOR: Rotate on account of Max delay of" + tkr )
            this.rotateEvtSubProvider()
        }
    }
    // we already checked that there is new data in cylcevals
    let last = cyclevals[cyclevals.length-1]
    const csvString = `${tkr},${last.timestamp},${last.tick}\n`;
    fs.appendFile('tickdelt.csv', csvString, (err) => { if (err) throw err });
    }
}

async getPosVal(leg: Market): Promise<Number> {
    let pv =  (await this.perpService.getTotalPositionValue(leg.wallet.address, leg.baseToken)).toNumber()
    return pv
 }

 async isNonZeroPos(leg: Market): Promise<boolean> {
    let pos = (await this.perpService.getTotalPositionValue(leg.wallet.address, leg.baseToken)).toNumber()
    return (pos != 0)
 }

 async bkpopen(mkt: Market, usdAmount: number ) {
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
            // update mkt.size and mkt.basis using pool latest price
            let sz = (await this.perpService.getTotalPositionSize(mkt.wallet.address, mkt.baseToken)).toNumber()
            //TODO.DEBT ensure is not undefined
            let price = Math.pow(1.001, this.poolState[mkt.tkr].tick!)
            this.marketMap[mkt.name].openMark = price
            // update startSize if first open or was open at restart
            if (mkt.startSize == null) { mkt.startSize = sz }
            // make sure to null on close
        }
        catch (e: any) {
            console.error(`ERROR: FAILED OPEN. Rotating endpoint: ${e.toString()}`)
            this.ethService.rotateToNextEndpoint()
            await this.openPosition( mkt.wallet,mkt.baseToken,mkt.side,AmountType.QUOTE, Big(usdAmount),undefined,undefined,undefined )
            console.log("Re-oppened...")
        }
 }

 async open(mkt: Market, usdAmount: number ) {
    if (config.DEBUG_FLAG) {
        console.log("DEBUG: open: " + mkt.name + " " + usdAmount)
        return
    }
    try {
        await this.openPosition(mkt.wallet, mkt.baseToken ,mkt.side ,AmountType.QUOTE,Big(usdAmount),undefined,undefined,undefined)
     }
    catch (e: any) {
        console.error(`ERROR: FAILED OPEN. Rotating endpoint: ${e.toString()}`)
        this.ethService.rotateToNextEndpoint()
        try {
            await this.openPosition(mkt.wallet,mkt.baseToken,mkt.side,AmountType.QUOTE, Big(usdAmount),undefined,undefined,undefined)
            console.log("INFO: Re-opened...")
        } catch (e: any) {
            console.error(`ERROR: FAILED SECOND OPEN: ${e.toString()}`)
            throw e
        }
    }
    // open was successful. update pricing
        let scoll = (await this.perpService.getAccountValue(mkt.wallet.address)).toNumber()
        console.warn("WARN: using twap based getAccountValue to compute basis. FIXME!")
        mkt.basisCollateral = scoll
        mkt.startCollateral = scoll
           // update mkt.size and mkt.basis using pool latest price
           let sz = (await this.perpService.getTotalPositionSize(mkt.wallet.address, mkt.baseToken)).toNumber()
           //TODO.DEBT ensure is not undefined
           let price = Math.pow(1.001, this.poolState[mkt.tkr].tick!)
           this.marketMap[mkt.name].openMark = price
           // update startSize if first open or was open at restart
           if (mkt.startSize == null) { mkt.startSize = sz }
           // make sure to null on close
 }

 // close sort of dtor. do all bookeeping and cleanup here
 //REFACTOR: this.close(mkt) will make it easier for functinal styling
 // onClose startCollateral == basisCollateral == settledCollatOnClose
// re-implement provderRotationLogic



 BKProtateToNextProvider() {
    // upon running eth.rotateToNextEndpoint. listeners are lost. need to re-register against new provider in ethService
    this.ethService.rotateToNextEndpoint()
    this.setupPoolListeners()
    //let tmstmp = new Date().toLocaleTimeString([], {hour12: false, timeZone: 'America/New_York'});
    console.log(Date.now() + " SETUP: rereg listeners: " + this.ethService.provider.connection.url)
 }

 // takes [timestamp, tick] pairs and returns the weighted geometric mean of the ticks

//TODO convert to geometric weighted mean
computeWeightedArithAvrg(cticks: TickData[], cweights: number[]): number {
    let sum = 0;
    let weightSum = 0;
    const n = cticks.length;
    for (let i = n - 1; i >= 0; i--) {
      const tick = cticks[i].tick;
      const weight = cweights[n - 1 - i];
      sum += tick * weight;
      weightSum += weight;
    }
    return sum / weightSum;
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

        // null out mkt.size and mkt.basis
        this.marketMap[mkt.name].startSize = null
        this.marketMap[mkt.name].openMark =null
        }
    catch (e: any) {
            console.log(`ERROR: FAILED CLOSE ${mkt.name} Rotating endpoint: ${e.toString()}`)
            this.ethService.rotateToNextEndpoint()
            // one last try....
            await this.closePosition(mkt.wallet, mkt.baseToken, undefined,undefined,undefined)
            console.log(Date.now() + " SETUP: Recovery closed after rotation")
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

  genTWreport() {
    const writeStream = fs.createWriteStream('twreport.csv');
    writeStream.write(`name, startCollat, endCollat, isSettled\n`);
  
    for (const m of Object.values(this.marketMap)) {
      const isSettled = m.startCollateral === m.basisCollateral ? "true" : "false";
      writeStream.write(`${m.name}, ${m.initCollateral}, ${m.basisCollateral}, ${isSettled}\n`);
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


// determine from beth mkt direction. input poolData from updatePoolData 
// cmp unpacking date to current cycle for both to det if this data
BKPmktDirectionChangeCheck(): void {
    // wait until vETH and vBTC have data. usint timestamp as flag
    let btcbkt = this.poolState["vBTC"].bucket
    let ethbkt = this.poolState["vETH"].bucket
    let bnbbkt = this.poolState["vBNB"].bucket

    //if (!btcbkt.length || !ethbkt.length || !bnbbkt.length )  { return }
    let btcDelta, ethDelta, bnbDelta
//    let btcDelta = this.poolState["vBTC"].bucket[btcbkt.length-1].tick - this.poolState["vBTC"].bucket[0].tick
  //  let ethDelta = this.poolState["vETH"].bucket[ethbkt.length-1].tick - this.poolState["vETH"].bucket[0].tick
    //let bnbDelta = this.poolState["vBNB"].bucket[bnbbkt.length-1].tick - this.poolState["vBNB"].bucket[0].tick

    // if there is only one tick. during slock markets. compare latest tick with penultime tick
    // zero the delta if older than a cyle
    let cutoff = Date.now() - config.PRICE_CHECK_INTERVAL_SEC*1000
    if ( !btcbkt.length || (btcbkt[btcbkt.length-1].timestamp < cutoff) ) { btcDelta = 0 }
    else if (btcbkt.length == 1) {  // use prevtick if butcket has only one entry. slow market or tight cycle
        if (this.poolState["vBTC"].prevTick == undefined) { this.poolState["vBTC"].prevTick = btcbkt[0].tick }
        btcDelta = this.poolState["vBTC"].bucket[0].tick - this.poolState["vBTC"].prevTick
    }
    else { btcDelta = this.poolState["vBTC"].bucket[btcbkt.length-1].tick - this.poolState["vBTC"].bucket[0].tick }

    // repeat for eth
    if( !ethbkt.length || (ethbkt[ethbkt.length-1].timestamp < cutoff) ) { ethDelta = 0 }
    else if (ethbkt.length == 1) {
        if (this.poolState["vETH"].prevTick == undefined) { this.poolState["vETH"].prevTick = ethbkt[0].tick }
        ethDelta = this.poolState["vETH"].bucket[0].tick - this.poolState["vETH"].prevTick
    }
    else { ethDelta = this.poolState["vETH"].bucket[ethbkt.length-1].tick - this.poolState["vETH"].bucket[0].tick }

    // repeat for bnb
    if ( !bnbbkt.length || (bnbbkt[bnbbkt.length-1].timestamp < cutoff) ) { bnbDelta = 0 }
    else if (bnbbkt.length == 1) {  
        if (this.poolState["vBNB"].prevTick == undefined) { this.poolState["vBNB"].prevTick = bnbbkt[0].tick }
        bnbDelta = this.poolState["vBNB"].bucket[0].tick - this.poolState["vBNB"].prevTick
    }
    else { bnbDelta = this.poolState["vBNB"].bucket[bnbbkt.length-1].tick - this.poolState["vBNB"].bucket[0].tick }

       // count how many deltas  > config.TP_DIR_MIN_TICK_DELTA
    let deltas = [btcDelta, ethDelta, bnbDelta]
    let jmps = deltas.filter(delta => Math.abs(delta) > config.TP_DIR_MIN_TICK_DELTA)
    // zebra until proven different  
   this.holosSide = Direction.ZEBRA
   // lenght > 1 i.e 2 out of 3 until implement 30-1minute weights geometric return 
    if (jmps.length > 1 && jmps.every(delta => delta > 0)) { 
        this.holosSide = Direction.TORO } 
    else if (jmps.length > 1 && jmps.every(delta => delta < 0)) { 
        this.holosSide = Direction.BEAR }

    // all must be in agreement. else return
    console.log(Date.now() + " MKT: " + this.holosSide + ":" + btcDelta + ", " + ethDelta + ", " + bnbDelta)
}
// consumes data filled by processEventInpput
mktDirectionChangeCheck(): void {
 // recall cycleDelta is the 1min-weighted-tick - 30min-weighted-basis tick. if 
    let btcDelta = this.poolState["vBTC"].cycleTickDelta
    let ethDelta = this.poolState["vETH"].cycleTickDelta
    let bnbDelta = this.poolState["vBNB"].cycleTickDelta

    // count how many deltas  > config.TP_DIR_MIN_TICK_DELTA
    let deltas = [btcDelta, ethDelta, bnbDelta]
    //trace
if (config.TRACE_FLAG) { console.log(Date.now() + " TRACE: mktDir: " + btcDelta.toFixed() + ", " + ethDelta.toFixed() + ", " + bnbDelta.toFixed()) }
    let jmps = deltas.filter(delta => Math.abs(delta) > config.TP_DIR_MIN_TICK_DELTA)
    // zebra until proven different  
    this.holosSide = Direction.ZEBRA
    // HACK: if 2 out of 3 deltas > config.TP_DIR_MIN_TICK_DELTA AND same sign then we have conviction
    if (jmps.length > 1 && jmps.every(delta => delta > 0)) { this.holosSide = Direction.TORO } 
    else if (jmps.length > 1 && jmps.every(delta => delta < 0)) { this.holosSide = Direction.BEAR }
    
    if( btcDelta || ethDelta || bnbDelta) { 
        console.log(Date.now() + " MKT: " + this.holosSide + ":" + btcDelta + ", " + ethDelta + ", " + bnbDelta)
    }
}

//----------------------------------
// wakeUpCheck
//-----
async wakeUpCheck(mkt: Market): Promise<boolean> { 
    // return if no new data or no new data i.e older than 1 cyle
    let ts = this.poolState[mkt.tkr].cycleTickDeltaTs
    let now = Date.now()
    let cutoff = now - config.PRICE_CHECK_INTERVAL_SEC*1000
if (config.TRACE_FLAG) { console.log(now + " TRACE: wakeUpCheck: " + mkt.tkr + " ctickDlt: " + ts + " cutoff: " + cutoff + " " + age) }
    if (this.poolState[mkt.tkr].cycleTickDeltaTs < cutoff ) { return false }
    
    let tickDelta = this.poolState[mkt.tkr].cycleTickDelta
    // if absolute tickDelta too small dont bother
if (config.TRACE_FLAG) { console.log(now + " TRACE: wakeUpCheck: " + mkt.tkr + " tkdlt: " + tickDelta.toFixed()) }
    if (Math.abs(tickDelta) < mkt.longEntryTickDelta) { return false }
    
  // wake up long/sThort on tick inc
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
    else if ( (mkt.side == Side.SHORT) && (tickDelta < 0)
                                       && (Math.abs(tickDelta) > mkt.shortEntryTickDelta) 
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
        console.log(this.holosSide + ": tickDelta:" + mkt.name + ": " + tickDelta)
    }

    return false
}

async BKPwakeUpCheck(mkt: Market): Promise<boolean> { 
    // return if no new data or no new data i.e older than 1 cyle
    let len = this.poolState[mkt.tkr].bucket.length
    if (len == 0) { return false }
    let cutoff = Date.now() - config.PRICE_CHECK_INTERVAL_SEC*1000
    if (this.poolState[mkt.tkr].bucket[len-1].timestamp < cutoff ) { return false }
    
    // new data in bucket. NAIVE: get the dlta btwin last and first
    let tickDelta = this.poolState[mkt.tkr].bucket[len-1].tick - this.poolState[mkt.tkr].bucket[0].tick

    // if absolute tickDelta too small dont bother
    if (Math.abs(tickDelta) < mkt.longEntryTickDelta) { return false }
    
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
    else if ( (mkt.side == Side.SHORT) && (tickDelta < 0)
                                       && (Math.abs(tickDelta) > mkt.shortEntryTickDelta) 
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
        console.log(this.holosSide + ": tickDelta:" + mkt.name + ": " + tickDelta)
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

// called after maxloss completed. 
async solidarityKill(unfavSide: Side) {
    // filter nonzero position in unfavSide
    let deathrow: Market[] = []
    for (const m of Object.values(this.marketMap)) {
      let pos = await this.getPosVal(m)
      if (pos !== 0 && m.side === unfavSide) { deathrow.push(m) }
    }
    // clemency for good performers
    let pardonned = Object.values(deathrow)
                          .filter((n) => n.basisCollateral / n.startCollateral > config.TP_MIN_PARDON_RATIO )
    // cull the undesirebles
    console.log(`INFO: PARDONNED:  ${pardonned.map(m => m.name).join(', ')}`);

    let toExecute = deathrow.filter( (n) => !pardonned.includes(n) )
    if (toExecute.length) {
        for (const m of deathrow ) {
            let tstmp = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
            console.log(tstmp + " INFO: SolKill: " + m.name)
            try { await this.close(m) }
            catch { "QRM.Close failed:" + m.name }
        }
    }
}

/*

// DESC: flags if regime switch to one sided (bull or bear) really is a Participation signal
// uret < TP_QRM_MIN_RET. this value SHOULD be higher than TP_MAX_LOSS_RATIO e.g if maxloss is 91 
// MIN RATIO would be something like 92 
// regime switch is based on qurom on BOTH active/inactive mkts with a minum number of long/short
// required e.g for 2/3 then 5 modulus 2*5/3 => 2 for 6  => modulus 2*6/3 = 4
// TODO. should incorporate duration to be sqr adjusted to 200 ticks/15 seq to a TP_DURATION (30 minute?)
// ASSERT TP_MIN_COL_RATIO > TP_MAX_LOSS
// Critera for regime switch: collateral/startCollateral == MaxLoss collateral ratio
// Criterial can be cusotmizez

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
/*/ equivalent to accountValue (pnlAdjusted value)
 async getMarkPnl(mkt: Market) :Promise<number> {
    // should only get here if tick, size and openMark are defined
    let markpnl = 0
    // get current position value. mkt.size is updated by this.open and this.close
    use cumulative as markprice >>>>>>>>>>>>>>>>>>>>>
    let markprice = this.poolState[mkt.tkr].cumulativeTick?.refCumTick

    //let markPrice = Math.pow(1.0001,this.poolState[mkt.tkr].tick!)
    let sz = await this.perpService.getTotalPositionSize(mkt.wallet.address, mkt.baseToken)
    let pval = sz.toNumber() * markPrice
    // get start position value. updated by this.open. this.close sets it to null
    let startPval = mkt.startSize! * mkt.openMark! 
    markpnl = pval - startPval
    return markpnl
}*/

//----------------------------------------------------------------------------------------------------------
// this check also update state: peak and uret
// COND-ACT: on TP_MAX_LOSS close leg. When twin MAX_LOSS (pexit) rollStateCheck will restart
// SIDEff: mkt.startCollatera onClose and also on new peak
// Error: throws open/close
// NOTE: when dado is stopped 
//----------------------------------

async maxLossCheckAndStateUpd(mkt: Market): Promise<boolean> {
    // skip if market inactive
    let check = false ; let markPnl = 0 ; let mret = null
    let leg = this.marketMap[mkt.name]
    if (await this.isNonZeroPos(leg)) { 
        // collatbasis is the peak colateral
        let collatbasis = mkt.basisCollateral
        const col = (await this.perpService.getAccountValue(mkt.wallet.address)).toNumber()
        let uret = 1 + (col - collatbasis)/collatbasis
        if (uret < config.TP_MAX_ROLL_LOSS ) { check = true  }// mark check positive 

        // peak update. startCollateral is always realized. basisCollateral unrealized
        if (col > collatbasis) {  mkt.basisCollateral = col }  
        // update uret used by qrom holos check. Used at all?? rmv
        mkt.uret = uret
        // compute real return based on mark price based pnl. can only compute if sz and tick are nonzero
        //let tk = this.poolState[mkt.tkr].tick
        // use cumrefTick as markprice
        
        let tk = this.poolState[mkt.tkr].cumulativeTick?.refCumTick
        if (mkt.startSize && mkt.openMark && tk) { 
            //markPnl = await this.getMarkPnl(mkt, tk) 
            // (collatbasis + markPnl - collatbasis)/collatbasis = 1 + markPnl/collatbasis
            mret = 1 + (markPnl)/collatbasis
        }
        else if (!mkt.startSize || !mkt.openMark) { // if no mkt size, pos WAS open at restart. get it from perpService
            if (!mkt.startSize) {
              mkt.startSize = (await this.perpService.getTotalPositionSize(mkt.wallet.address, mkt.baseToken)).toNumber();
            }
            if (!mkt.openMark) {
              let twappx = (await this.perpService.getTotalPositionValue(mkt.wallet.address, mkt.baseToken)).toNumber();
              console.warn("WARN: using twap to set openMark in: " + mkt.name)
              this.marketMap[mkt.name].openMark = twappx/mkt.startSize
            }
          }
          console.log(mkt.name + " cbasis:" + mkt.basisCollateral.toFixed(2) + "IPX uret:" + uret.toFixed(4) +
          " mret:" + (mret?.toFixed(4) ?? "null") + " mpnl:" + markPnl.toFixed(4));
    } 
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
    //await this.ensureSwapListenersOK()
    // new cycle. update cycle deltas based on what events have been received since last cycle
    this.processEventInputs()

    // now that cycle events delta. first things first.check for TP_MAX_LOSS
    if ( await this.maxLossCheckAndStateUpd(market) ) {   // have a positive => close took place. check for qrom crossing
        await this.putMktToSleep(market)

        // >>>>>>>>>>>>>> UNCOMMENT THIS TO ENABLE SOLIDARITY KILL
        //await this.solidarityKill(market.side)  WARN: diabling until fix return
    }
    //updat pool data
    //this.checkOnPoolSubEmptyBucket() //<========================== poolSubChecknPullBucket
    this.mktDirectionChangeCheck()  // asses direction. WAKEUP deps on this
      // MMR. maximum margin RESET check
    await this.maxMaxMarginRatioCheck(market)
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
        
e    }*/
}