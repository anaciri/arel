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
import { max, padEnd, update, upperFirst } from "lodash"
import { decode } from "punycode"
import { Service } from "typedi"

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
import { parse } from 'csv-parse';
import { getHeapSnapshot } from "v8"
import { readFileSync } from 'fs';

interface MarketConfig {
    IS_ENABLED: boolean;
    TP_LONG_MIN_TICK_DELTA: number;
    TP_SHORT_MIN_TICK_DELTA: number;
    IS_EMERGENCY_REDUCE_MODE_ENABLED?: boolean;
    MIN_RETURN: number;
    MAX_RETURN: number;
    MIN_MARGIN_RATIO: number;
    MAX_MARGIN_RATIO: number;
    START_COLLATERAL: number;
    RESET_MARGIN: number;
  }
  
//const jsonfile = require('jsonfile');
let dbgcTicks: TickData[] = []; // declare variable outside if statement
let dbgmTicks: TickData[] = [];

const configPath = process.env.CONFIG_PATH;
if (!configPath) { throw new Error('CONFIG_PATH environment variable is not set.') }

const configJson = readFileSync(configPath, 'utf-8');
const config = JSON.parse(configJson);

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
//const TP_MR_INC_SZ = 0.02  // OJO you INC onStopLoss 5x

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

interface Result<T> { error?: Error; positive: T | null;}

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
    wpeakTick: Tick // peak cycle wpx since duration of bot
    wcycleTick: Tick // cycle_wpx
    cycleTickDeltaTs: Timestamp
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
    idxBasisCollateral: number // uses idx based getAccountVal
    wBasisCollateral: number  // uses getPnLAdjustedCollateral valu
    startCollateral: number // gets reset everytme we reopen
    initCollateral: number  // read from config aka seed
    twin: string
//    peakCollateral: number
    resetMargin: number
    basisMargin: number
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

    //private evtSubProvider!: ethers.providers.Provider//StaticJsonRpcProvider | WebSocketProvider;
    private evtProviders: ethers.providers.Provider[] = [];
    
    // NOTE evtSubProvider (weather rpc or websocket) initialized from EVENT_SUB_ENDPOINTS, is NOT used for tx, 
    // BotService.etherService.provider is used for tx alowg with its etherservice.rotateNextProvider
    // evtSubProvider have their own rotateEvtSubProvider called on close or disconnect
    private evtSubProviderEndpoints: string[] = []
    private evtSubEndpointsIndex: number = 0
    private evtBuffer: { [key: string]: CircularBuffer } = {};
    //convinienc list of enbled market
    enabledMarkets: string[] =[]
    enabledLegs: string[] =[]
    
    evtRotateProvider() {
        // Get the current provider and remove its event listeners
        const currentProvider = this.evtProviders[ this.evtSubEndpointsIndex ];
        if (currentProvider instanceof ethers.providers.WebSocketProvider) {
          currentProvider._websocket.removeAllListeners('close');
          currentProvider._websocket.removeAllListeners('disconnect');
        }
        currentProvider.removeAllListeners();
    
        // Switch to the next provider
        const fromEndpoint = this.evtSubProviderEndpoints[this.evtSubEndpointsIndex];
        this.evtSubEndpointsIndex = (this.evtSubEndpointsIndex + 1) % this.evtProviders.length;
        const toEndpoint = this.evtSubProviderEndpoints[this.evtSubEndpointsIndex];

        const nextProvider = this.evtProviders[this.evtSubEndpointsIndex];
        // Add close/desconnect websocke event listeners if wss
        if (nextProvider instanceof ethers.providers.WebSocketProvider) {
          nextProvider._websocket.on('close', () => {
            console.warn(Date.now() + ' WARN: Closed  ' + nextProvider.connection.url);
            this.evtRotateProvider();
          });
          nextProvider._websocket.on('disconnect', () => {
            console.warn(Date.now() + ' WARN: Disconnected ' + nextProvider.connection.url);
            this.evtRotateProvider();
          });
        }// infinite recursion potential?
        //nextProvider.on('error', (error) => { console.error(Date.now() + ' ERROR: ' + error.message);this.evtRotateProvider();});
       
        // reinstall swap event listeners
        this.setupPoolListeners()
        console.warn( Date.now() + " EVTMON: EvtSubProv Rotation from " + fromEndpoint + " to: " + toEndpoint)
        console.log( Date.now() + " EVTMON: EvtSubProv Rotation from " + fromEndpoint + " to: " + toEndpoint)
      }
    
    setupEvtProviders() {
        // Create upfront the event providers (not the tx providers) based on url
        this.evtSubProviderEndpoints = process.env.EVENT_SUB_ENDPOINTS!.split(",");
        if (!this.evtSubProviderEndpoints) {
          throw new Error("NO Subscription Providers in .env");
        } else { // instantiate the providers
          for (const endpoint of this.evtSubProviderEndpoints) {
            if (endpoint.startsWith("wss:")) {
              const provider = new ethers.providers.WebSocketProvider(endpoint);
              provider._websocket.on("disconnect", () => {
                console.warn(Date.now() + " WARN: Disconnected " + provider.connection.url);
                this.evtRotateProvider();
              });
              provider._websocket.on("close", () => { // handle permanent disconnect
                console.warn(Date.now() + " WARN: Closed  " + provider.connection.url);
                this.evtRotateProvider();
              });

              this.evtProviders.push(provider);
            } else { //is an rpc provider for the event subscrpition!
              const provider = new ethers.providers.StaticJsonRpcProvider(endpoint);
              this.evtProviders.push(provider);
            }
          }
        }
      }
      


    async setup(): Promise<void> {
        
       // Print the names and values of all the variables that match the pattern 'v[A-Z]{3,}'
        const pattern = /^v[A-Z]{2,}/  
        let vk = Object.entries(process.env).filter(([k])=> pattern.test(k))
        for (const [key, value] of vk) { this.pkMap.set(key, value!) }
          
        // initilize pkMap
        let wlts = transformValues(this.pkMap, v => this.ethService.privateKeyToWallet(v))
        // needed by BotService.retrySendTx
        await this.createNonceMutex([...wlts.values()])
        await this.createMarketMap()
        // 2. allocate memory for evtBuffers for enabled tickers
        this.initDataStructs()
        this.createPoolStateMap() //<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<--- rename to initDataStruc

//--------- FACTOR OUT into separete func that can handle any type of provider        
// this initializes ONLY the event providers NOT L2_WEB3_ENDPOINTS /
/* HIDE

this.evtSubProviderEndpoints = process.env.EVENT_SUB_ENDPOINTS!.split(",");
if (!this.evtSubProviderEndpoints) { throw new Error("NO Subscription Providers in .env");} 
else {
    const providerEndpoint = this.evtSubProviderEndpoints[this.evtSubEndpointsIndex];
    this.evtSubProvider = providerEndpoint.startsWith("wss:")
    ? new ethers.providers.WebSocketProvider(providerEndpoint)
    : new ethers.providers.JsonRpcProvider(providerEndpoint);
}  
HIDE */ 
this.setupEvtProviders()
        //%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%   $$$$$$$$$$$$$$$$$$$$  @@@@@@@@@@@@@@@@@@@@@@ REMOVE ME!!!
        if (config.DEBUG_FLAG) {
    //this.evtRotateProvider()
 }
        
//----- END FACTOR OUT ------------------------------------------

        //else { this.evtSubProvider = new ethers.providers.JsonRpcProvider(this.evtSubProviderEndpoints[this.evtSubEndpointsIndex]);}
        await this.setupPoolListeners()
        /*/ move this to checker
        const proxies = ["vBTC", "vETH", "vBNB"]
        for (const tkr of proxies) {
            let subs = this.poolState[tkr].poolContract.filters.Swap()
            console.log("SETUP: proxy topics " + tkr + ": " + subs.topics)
        }*/
        
       // console.log("CROC: EvtSubProv: " + this.evtSubProvider.connection.url)
        
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
            //this.rotateEvtSubProvider()
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

  
    // agnostic if rpc or websocket
    async setupPoolListeners(): Promise<void> {
        let currprovider = this.evtProviders[this.evtSubEndpointsIndex]
        let url =""
        if (currprovider instanceof ethers.providers.WebSocketProvider) { url = (currprovider as ethers.providers.WebSocketProvider).connection.url} 
        else if (currprovider instanceof ethers.providers.JsonRpcProvider) { url = (currprovider as ethers.providers.JsonRpcProvider).connection.url}
        console.log(Date.now() + " EVTMON: evtprovider: " + url)

        for (const tkr of this.enabledMarkets) {
            const unipool = new ethers.Contract( this.poolState[tkr].poolAddr, IUniswapV3PoolABI.abi, currprovider)

//            const unipool = new ethers.Contract( this.poolState[tkr].poolAddr, IUniswapV3PoolABI.abi, this.evtSubProvider)
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
                wpeakTick: 0,
                wcycleTick: 0,
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
        //for (const [marketName, market] of Object.entries(config.MARKET_MAP)) {
        for (const [marketName, marketConfig] of Object.entries(config.MARKET_MAP)) {
            const market: MarketConfig = marketConfig as MarketConfig;
            if (!market.IS_ENABLED) { continue }
            //if (!market.IS_ENABLED) { continue }
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
                //maxMarginRatio: market.MAX_MARGIN_RATIO,
                maxMarginRatio: market.RESET_MARGIN + config.TP_MARGIN_STEP_INC,
                initCollateral: market.START_COLLATERAL,  // will not change until restart
                startCollateral: market.START_COLLATERAL, // will change to previous settled collatera
                idxBasisCollateral: market.START_COLLATERAL, // incl unrealized profit
                wBasisCollateral: market.START_COLLATERAL, // same starting point as idx
                resetMargin: market.RESET_MARGIN,
                basisMargin: market.RESET_MARGIN,
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
            this.enabledLegs.push( marketName)
            this.enabledMarkets.push( marketName.split('_')[0])
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
        let lastEvtCheckTime = Date.now()
        while (true) {
            //TODO.STK turn on heart beat below
            //this.markRoutineAlive("ArbitrageRoutine")
            await Promise.all(
                Object.values(this.marketMap).map(async market => {
                    try {
                        //await this.arbitrage(market)
                        await this.checksRoutine(market)
                    } catch (err: any) { await this.jerror({ event: "XCEPT: " + market.name, params: { err } })
                    }
                }),
            )
            await sleep(config.PRICE_CHECK_INTERVAL_SEC * 1000)

            // Run evtNodeCheck if EVT_PROVIDER_CHECK_INTERVAL_SEC seconds have elapsed since the last call
            const now = Date.now();
            if ( now - lastEvtCheckTime >= config.EVT_PROVIDER_CHECK_INTERVAL_SEC * 1000 ) {
                this.evtNodeCheck( lastEvtCheckTime )
                lastEvtCheckTime = now; // update the lastEvtCheckTime variable with the current time
            }
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
// should work regardless of rpc or websocket protocol
/*rotateEvtSubProvider() {
    //rotateToNextEndpoint(callback = undefined) {
        this.evtSubProvider.removeAllListeners()
        const fromEndpoint = this.evtSubProviderEndpoints[this.evtSubEndpointsIndex];
        this.evtSubEndpointsIndex = (this.evtSubEndpointsIndex + 1) % this.evtSubProviderEndpoints.length;
        const toEndpoint = this.evtSubProviderEndpoints[this.evtSubEndpointsIndex];
        // reinstall listeners
        this.setupPoolListeners()
        console.log( Date.now() + " EVTMON: EvtSubProv Rotation from " + fromEndpoint + " to: " + toEndpoint)
}*/


// DEP: poolData filled by eventListener
// health check. 1) check foremost the proxies subscriptions are OK 2) check on the other pools
// detect discontinuity and drain bucket 
// tickBuff is the lowlevel DS using only by eventhandler and this checker that copies it inot statePool
//DEPRECATED
/*
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
        //if ( (age) > 1000 * config. ){
        if ( (age) > 1000 * config.MON_MAX_TIME_WITH_NO_EVENTS_SEC ){
            //this.rotateEvtSubProvider()
        }
    } catch (err: any) {
        if (err.code === 'ENOENT') { console.log('tick csv empty, skipping rotation check.');
        } else { throw err; }
      }
}
*/
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
    
    // skip this tkr if no data since last cycle
    if (Object.keys(cyclevals).length == 0) { continue }

    // compute the weighted arithmetic mean for the last cycle seconds
    const cticks = Object.values(cyclevals);
    const cweights = cticks.map((tick, i) => i + 1);
    const wtick = this.computeWeightedArithAvrg(cticks, cweights);
    // updated cycleTicks
    this.poolState[tkr].wcycleTick= wtick
    // pick highest magnitude value
    if ( Math.abs(wtick) > Math.abs(this.poolState[tkr].wpeakTick) ) { this.poolState[tkr].wpeakTick = wtick }

    // compute lastThirtyMinutes-memory (excluding the last cycle values)
    // first ensure we have some memory
    let membuffsz = this.evtBuffer[tkr].getLength()
    //if (membuffsz < cyclevals.length + 1) { return }
    if (membuffsz < cyclevals.length + 1) { continue }  // WAS a return, shoulnt be a continue? 
    const lastThirtyMinutesStart = cutoff - 30 * 60 * 1000;
    const lastThirtyMinutesData = this.evtBuffer[tkr].getDataAt(lastThirtyMinutesStart);
    // compute lastThirtyMinutes (excluding the last cycle values)
    lastThirtyMinutesData.splice(-cticks.length);
if( config.TRACE_FLAG) { console.log(now + " EVTSUB: " + tkr + " membuff.sz: " + membuffsz) }

    // compute the weighted arithmetic mean for the last thirty minutes
    const buffvals = Object.values(lastThirtyMinutesData);
    const bweights = buffvals.map((tick, i) => i + 1);
    const tickBasis = this.computeWeightedArithAvrg(buffvals, bweights);
if( config.TRACE_FLAG) { console.log(now + " EVTSUB: " + tkr + " wcycleTicks: " + wtick.toFixed() + " tickBasis: " + tickBasis.toFixed()) }

    // update cycleDelta for each pool. consumed by mktDirection and soon maxloss
    this.poolState[tkr].cycleTickDelta = wtick - tickBasis;
    this.poolState[tkr].cycleTickDeltaTs = cyclevals[cyclevals.length-1].timestamp
//if( config.TRACE_FLAG) { console.log(now + " TRACE: " + tkr + " cTkDelta: " + this.poolState[tkr].cycleTickDelta.toFixed()) }
    console.log( Date.now() + " EVTSUB: " + tkr + ": cycleTickDelta: " + this.poolState[tkr].cycleTickDelta.toFixed(2) )

    // check for discontinuity of events by comparing in the circular buffer age of the last buffer entry

    //&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&%%%%%%%%%%%%%%%%%%%%%%%%%%%%% FACTOR OUT

    const age = now - this.evtBuffer[tkr].getLatest().timestamp
    if ( age > config.MON_MAX_TIME_WITH_NO_EVENTS_SEC * 1000 ) { 
        console.warn(now + "MONITOR:" + tkr + ": No events in " + (age/60000).toFixed(2) + " mins")
        console.log( now + " MONITOR: " + tkr + ": No events in " + (age/60000).toFixed(2) + " mins")
        
        // if too long and proxy ticker rotate provider to be safe: NOT USING PROXY ANYMORE
        /*if ( tkr in ["vBTC", "vETH", "vBNB"]){
            console.log( Date.now() + " MONITOR: Rotate on account of Max delay of" + tkr )
            this.rotateEvtSubProvider()} */
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


 async open(mkt: Market, usdAmount: number ) {
    if (config.DEBUG_FLAG) {
        console.log("DEBUG: open: " + mkt.name + " " + usdAmount)
        return
    }
    try {
        await this.openPosition(mkt.wallet, mkt.baseToken ,mkt.side ,AmountType.QUOTE,Big(usdAmount),undefined,undefined,undefined)
     }
    catch (e: any) {
        console.error(mkt.name + ` ERROR: FAILED OPEN. Rotating endpoint: ${e.toString()}`)
        this.ethService.rotateToNextEndpoint()
        try {
            await this.openPosition(mkt.wallet,mkt.baseToken,mkt.side,AmountType.QUOTE, Big(usdAmount),undefined,undefined,undefined)
            console.log(Date.now() + " " + mkt.name + " INFO: Re-opened...")
        } catch (e: any) {
            console.error(mkt.name + `: ERROR: FAILED SECOND OPEN: ${e.toString()}`)
            console.log(Date.now() + "," + mkt.name + ",FAIL: second reopen failed")
            throw e
        }
    }
    // open was successful. update pricing
        let scoll = (await this.perpService.getAccountValue(mkt.wallet.address)).toNumber()
        console.warn("WARN: using twap based getAccountValue to compute basis. FIXME!")
        mkt.idxBasisCollateral = scoll
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
  
  // Butils.ts
  // check if data is new since last routine cyle
  newDataAvailableAtTs(ts: Timestamp): boolean {
    let now = Date.now()
    let cutoff = now - config.PRICE_CHECK_INTERVAL_SEC*1000
    if (ts > cutoff) { return true }
    return false
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
        mkt.idxBasisCollateral = scoll
        mkt.startCollateral = scoll
        //reset peakTick. eventInput will set it again
        mkt.wBasisCollateral = scoll
        this.poolState[mkt.tkr].wpeakTick = scoll

        // null out mkt.size and mkt.basis
        this.marketMap[mkt.name].startSize = null
        this.marketMap[mkt.name].openMark =null
        }
    catch (e: any) {
            console.log(mkt.name + ` ERROR: FAILED CLOSE ${mkt.name} Rotating endpoint: ${e.toString()}`)
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
            console.error(mkt.name + ` ERROR: FAILED CLOSE. Rotating endpoint: ${e.toString()}`)
            this.ethService.rotateToNextEndpoint()
            await this.closePosition(mkt.wallet, mkt.baseToken, undefined,undefined,undefined)
            console.log("closed...")
            // AYB Making it throwable
            throw e
        }
 } 

 
// dont hang around too much
 async genTWreport() {
    const writeStream = fs.createWriteStream('twreport.csv');
    writeStream.write(`name, startCollat, endCollat, bmargin, open\n`);
  
    for (const m of Object.values(this.marketMap)) {
      let open = await this.isNonZeroPos(m) ? "true" : "false";
      //let finalcollat = open ? this.poolState[m] : m.idxBasisCollateral
      writeStream.write(`${m.name}, ${m.initCollateral}, ${m.idxBasisCollateral}, ${m.basisMargin},${open}\n`);
    }
  
    writeStream.on('finish', () => {
      console.log('Report written successfully.');
//      this.updateConfig()
      process.exit(0);
    });
  
    writeStream.on('error', (err) => {
      console.error(`Failed to write report: ${err}`);
      process.exit(1);
    });
  
    writeStream.end();
  }

  BKPgenTWreport() {
    const writeStream = fs.createWriteStream('twreport.csv');
    writeStream.write(`name, startCollat, endCollat, isSettled\n`);
  
    for (const m of Object.values(this.marketMap)) {
      const isSettled = m.startCollateral === m.idxBasisCollateral ? "true" : "false";
      writeStream.write(`${m.name}, ${m.initCollateral}, ${m.idxBasisCollateral}, ${isSettled}\n`);
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

// consumes data filled by processEventInpput
mktDirectionChangeCheck(): void {
 // recall cycleDelta is the 1min-weighted-tick - 30min-weighted-basis tick. if 
    //check if new data is available
    let btcDelta = 0, ethDelta = 0, bnbDelta = 0
    let ts = this.poolState["vBTC"].cycleTickDeltaTs
    if (this.newDataAvailableAtTs(this.poolState["vBTC"].cycleTickDeltaTs) ) { 
        btcDelta = this.poolState["vBTC"].cycleTickDelta }  
    if (this.newDataAvailableAtTs(this.poolState["vETH"].cycleTickDeltaTs) ) {
        ethDelta = this.poolState["vETH"].cycleTickDelta }
    if (this.newDataAvailableAtTs(this.poolState["vBNB"].cycleTickDeltaTs) ) {
        bnbDelta = this.poolState["vBNB"].cycleTickDelta }
    
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
        console.log(Date.now() + " MKT: " + this.holosSide + ":" + btcDelta.toFixed() + ", " + ethDelta.toFixed() + ", " + bnbDelta.toFixed())
    }
}
// what legs have not been killed
async getOpenLegUrets() {
    const MAX_LEVERAGE = 10  // will be haircut
    // for the very first time you will need to have a minimum leverage otherwise factor will be zero
    //const START_MIN_LEVERAGE = 0.2 //so that you start at 0.2*10 = 2x leverage
    let uretlong = [];
    let uretshort = [];
    // NOTE: disregarding if the open position has negative uret but we are using uret for shortcut to 10x
    for (const tkr of this.enabledLegs) {
        const pos = (await this.perpService.getTotalPositionSize(
            this.marketMap[tkr].wallet.address,this.marketMap[tkr].baseToken )).toNumber()
        if      (pos > 0) { uretlong.push( this.marketMap[tkr].uret ) }         // open longs returns
        else if (pos < 0) { uretshort.push( this.marketMap[tkr].uret ) }   // open shorts returns
    } 
    return { uretLongs: uretlong, uretShorts: uretshort }
}
// returns a value from 0 to max laverage
// amygadala shortcut if side count is higher than qrom then automatic 10x in favored side and MIN leverage in other
// if both sides qrom i.e high dispersion then 10x in both and rely on maxloss/solidaritkll to exit
//TODO.DEPRECATED
async computeKellyLeverage() {
    const MAX_LEVERAGE = 10  // will be haircut
    // for the very first time you will need to have a minimum leverage otherwise factor will be zero
    //const START_MIN_LEVERAGE = 0.2 //so that you start at 0.2*10 = 2x leverage
    let uretLongs = [];
    let uretShorts = [];
    let positivePositions = [];
    let negativePositions = [];

    // NOTE: disregarding if the open position has negative uret but we are using uret for shortcut to 10x
    
    for (const tkr of this.enabledLegs) {
        const pos = (await this.perpService.getTotalPositionSize(
            this.marketMap[tkr].wallet.address,this.marketMap[tkr].baseToken )).toNumber()
        if (pos > 0) { //longs
            positivePositions.push(pos) 
            uretLongs.push( this.marketMap[tkr].uret )
        }
        else if (pos < 0) {  //shorts
            negativePositions.push(pos)
            uretShorts.push( this.marketMap[tkr].uret )
        }
    } 
    // compute kelly factors based on conviction
    const totalEnabledMarkets = this.enabledMarkets.length;
    let lkf = positivePositions.length / totalEnabledMarkets
    let skf = negativePositions.length / totalEnabledMarkets
    
    if(config.TRACE_FLAG) { console.log("TRACE: longs: " + positivePositions + " shors: " + negativePositions) }
    console.log("MON: long/short kelly: " + lkf.toFixed(2) + ", " + skf.toFixed(2)) 

    // overwrite if uretLongs/uretShorts count is geq than TP_QRM_MAX_LEVERAGE e.g if 3 (in a total set of 5) go strait to 1
    if (uretLongs.filter((uret) => uret > config.TP_QRM_MIN_RET).length >= config.TP_QRM_FOR_MAX_LEVERAGE) { lkf = MAX_LEVERAGE }
    if (uretShorts.filter((uret) => uret > config.TP_QRM_MIN_RET).length >= config.TP_QRM_FOR_MAX_LEVERAGE) { skf = MAX_LEVERAGE }

    return {longKellyLvrj: MAX_LEVERAGE*lkf, shortKellyLvrj: MAX_LEVERAGE*skf};
}
//----------------------------------
// wakeUpCheck
//-----
async wakeUpCheck(mkt: Market): Promise<boolean> { 
    const MAX_LEVERAGE  = 9.96
    // return if no new data or no new data i.e older than 1 cyle
    let ts = this.poolState[mkt.tkr].cycleTickDeltaTs
    let now = Date.now()
    let cutoff = now - config.PRICE_CHECK_INTERVAL_SEC*1000
if (config.TRACE_FLAG) { console.log(now + " TRACE: wakeUpCheck: " + mkt.tkr + " ctickDlt: " + ts + " cutoff: " + cutoff ) }
    if (this.poolState[mkt.tkr].cycleTickDeltaTs < cutoff ) { return false }
    
    let tickDelta = this.poolState[mkt.tkr].cycleTickDelta

    // if absolute tickDelta too small dont bother
if (config.TRACE_FLAG) { console.log(new Date().toLocaleString() + " TRACE: wakeUpCheck: " + mkt.tkr + " tkdlt: " + tickDelta.toFixed()) }

    if (Math.abs(tickDelta) < mkt.longEntryTickDelta) { return false }
    
  // wake up long/sThort on tick inc
    //let dir = this.holosSide
    if ( (mkt.side == Side.LONG) && (tickDelta > mkt.longEntryTickDelta) ) {
        let pos = (await this.perpService.getTotalPositionValue(mkt.wallet.address, mkt.baseToken)).toNumber()
        
        // check if position already open first
        if(!pos) { 
                // compute factors
                //let lkf = (await this.computeKellyFactors()).longKellyFactor
                let sz = mkt.startCollateral / mkt.resetMargin
                /*
                let sz = mkt.startCollateral*lkf*MAX_LEVERAGE 
                if (!lkf) { 
                    //throw and error and log. error
                    let err = " FAIL: kellyfactor zero in nonzero pos: " + mkt.name + " lfk: " + lkf
                    console.error(err)
                    throw (Date.now() + err )
                 }*/
            
                try { await this.open(mkt,sz) }
                catch(err) { console.error(Date.now() + mkt.tkr +  " OPEN FAILED in wakeUpCheck") }

                let tstmp = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
                console.log(tstmp + " INFO: WAKEUP:" + mkt.name + " Dt:" + tickDelta.toFixed(4))
                return true
        }
    }
    else if ( (mkt.side == Side.SHORT) && (tickDelta < 0) && (Math.abs(tickDelta) > mkt.shortEntryTickDelta) ) {
        // ensure not open aleady
        let pos = (await this.perpService.getTotalPositionValue(mkt.wallet.address, mkt.baseToken)).toNumber()
        if(!pos) { 
            // compute factors
            /*
            let skf = (await this.computeKellyFactors()).shortKellyFactor
            if (!skf) {
                 //throw and error and log. error
                 let err =  " FAIL: kellyfactor zero in nonzero pos: " + mkt.name + " skf: " + skf
                 console.error(err)
                 throw (Date.now() + err )
                }
             */
            //let sz = mkt.startCollateral*skf*MAX_LEVERAGE 
            let sz = mkt.startCollateral / mkt.resetMargin
       
            try { await this.open(mkt,sz) }
            catch(err) { console.error(Date.now() + mkt.tkr +  " OPEN FAILED in wakeUpCheck") }

            let tstmp = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
            console.log(tstmp + " INFO: WAKEUP:" + mkt.name + " Dt:" + tickDelta.toFixed(4) )
            return true
        }
    }
    return false
}
async BKPwakeUpCheck(mkt: Market): Promise<boolean> { 
    // return if no new data or no new data i.e older than 1 cyle
    let ts = this.poolState[mkt.tkr].cycleTickDeltaTs
    let now = Date.now()
    let cutoff = now - config.PRICE_CHECK_INTERVAL_SEC*1000
if (config.TRACE_FLAG) { console.log(now + " TRACE: wakeUpCheck: " + mkt.tkr + " ctickDlt: " + ts + " cutoff: " + cutoff ) }
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
        catch(err) { console.error(Date.now() + mkt.tkr +  " OPEN FAILED in wakeUpCheck") }
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
        catch(err) { console.error(Date.now() + mkt.tkr +  " OPEN FAILED in wakeUpCheck") }
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
                          .filter((n) => n.idxBasisCollateral / n.startCollateral > config.TP_MIN_PARDON_RATIO )
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
        console.error(mkt.name + " Failed closed in putMktToSleep")
    }
         let oldStartCol = mkt.idxBasisCollateral
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
// index based pnl used in banger
async getIdxBasedPnl(mkt: Market) : Promise<number>{
    // pnl = sz * (pxcurrent -pxStart) ; 
    
    // note that current size maybe gt start size if already releveraged
    let csz = (await this.perpService.getTotalPositionSize(mkt.wallet.address, mkt.baseToken)).toNumber()
    // margin rate basis also may have changed from start on prior relevs
    // will use ipx for current valuation (same as perp uses). basis price wil be derived from basisMargin

    let currentPx = (await this.perpService.getIndexPrice(mkt.baseToken)).toNumber()
    // using initial collateral to see what the protocol sees.
    // mrstart = [pnl = 0 + collateraStart]/sz*pxstart =>  pxStart = collatStart/[sz*mrStart]
    let basisPrice = mkt.initCollateral/(csz*mkt.basisMargin)
    // pnl = sz * (pxcurrent -pxStart) ; 
    let pnl = csz * (currentPx - basisPrice)
if (config.TRACE_FLAG) { console.log("TRACE: getIndxPnl" + mkt.name + " sz: " + csz + " px: " + currentPx + " basispx: " + basisPrice + " pnl: " + pnl) }
    return pnl
}

// equivalent to accountValue (pnlAdjusted value). pnl using cycle-weighted-price cwp not memory weighted price (mwp)
// calculation: currCollatVal = basisCollateral + pnl = peakCollateral + pnl
// pnl = currPosVal - peakPosVal = wcp*size - peakPrice*size = size *(wcp - peakPrice)

 async getPnlAdjCollatValue(mkt: Market) :Promise<number> {
    // should only get here if tick, size and openMark are defined
    let wpnl = 0
    // get current position value. mkt.size is updated by this.open and this.close
    // price from wctick aka wpx
    //let markprice = this.poolState[mkt.tkr].cumulativeTick?.refCumTick
    let currtk = this.poolState[mkt.tkr].wcycleTick
    let peaktk = this.poolState[mkt.tkr].wpeakTick
    // either of the two zero. return basisCollateral
    if (!currtk || !peaktk) {return mkt.wBasisCollateral}

    let currpx = Math.pow(1.0001, currtk)
    let wpeakpx = Math.pow(1.0001, peaktk)
    let siz = await this.perpService.getTotalPositionSize(mkt.wallet.address, mkt.baseToken)

    // sz negative for short
    let sz = Math.abs(siz.toNumber())

    //let pval = sz.toNumber() * markPrice
    // get start position value. updated by this.open. this.close sets it to null
    //let startPval = mkt.startSize! * mkt.openMark! 
    //wpnl = pval - startPval
   // pnl = sz*(wcp - peakPrice)
    wpnl = sz*( currpx- wpeakpx)
    let currCollatVal = mkt.idxBasisCollateral + wpnl
if(config.TRACE_FLAG) { console.log(Date.now() + "wcol: " + mkt.name + " currpx: " + currpx.toFixed(4) + " wpeakpx: " + wpeakpx.toFixed(4) + " sz: " + sz.toFixed())}
    console.log(Date.now() + " wcol: " + mkt.name + " currcol: " + currCollatVal.toFixed(4) + " wpnl: " + wpnl.toFixed(4) )
    return currCollatVal
}

//----------------------------------------------------------------------------------------------------------
// this check also update state: peak and uret
// COND-ACT: on TP_MAX_LOSS close leg. When twin MAX_LOSS (pexit) rollStateCheck will restart
// SIDEff: mkt.startCollatera onClose and also on new peak
// Error: throws open/close
// NOTE: when dado is stopped 
//----------------------------------
// compute unrealized return using wcp. basis is the peak value/ current value is posizion size * wcp
// since we are using peakCollateral as collateral basis, we need to use peakPrice when computing uret
async maxLossCheckAndStateUpd(mkt: Market): Promise<boolean> {
    // skip if market inactive
    let check = false ; let markPnl = 0 ; let mret = null
    let leg = this.marketMap[mkt.name]
    if (await this.isNonZeroPos(leg)) { 
        // collatbasis is the peak colateral
        let collatbasis = mkt.idxBasisCollateral
        let wcollatbasis = mkt.wBasisCollateral
        // initially print both, plus good to check on divergencd
 //FIXME: getPnlAdjCollatValue        
        //const wcol = await this.getPnlAdjCollatValue(mkt)
        // getAccountValue is based on index price
        const icol = (await this.perpService.getAccountValue(mkt.wallet.address)).toNumber()
    
        //peak tick updated by eventInput procesor. they should match
        if (icol > mkt.idxBasisCollateral) { mkt.idxBasisCollateral = icol }
        //if (wcol > mkt.wBasisCollateral) { mkt.wBasisCollateral = wcol }

         let uret = 1 + (icol - collatbasis)/collatbasis
         //let wret = 1 + (wcol - wcollatbasis)/wcollatbasis
         mkt.uret = uret
        if (uret < config.TP_MAX_ROLL_LOSS ) { check = true  }// mark check positive 
          console.log(mkt.name + " ibasis:" + mkt.idxBasisCollateral.toFixed(2) + "idx uret: " + uret.toFixed(4))
    } 
    return check 
  }

async BKPmaxLossCheckAndStateUpd(mkt: Market): Promise<boolean> {
    // skip if market inactive
    let check = false ; let markPnl = 0 ; let mret = null
    let leg = this.marketMap[mkt.name]
    if (await this.isNonZeroPos(leg)) { 
        // collatbasis is the peak colateral
        let collatbasis = mkt.idxBasisCollateral
        let wcollatbasis = mkt.wBasisCollateral
        // initially print both, plus good to check on divergencd
        const wcol = await this.getPnlAdjCollatValue(mkt)
        // getAccountValue is based on index price
        const icol = (await this.perpService.getAccountValue(mkt.wallet.address)).toNumber()
    
        //peak tick updated by eventInput procesor. they should match
        if (icol > mkt.idxBasisCollateral) { mkt.idxBasisCollateral = icol }
        if (wcol > mkt.wBasisCollateral) { mkt.wBasisCollateral = wcol }

         let uret = 1 + (icol - collatbasis)/collatbasis
         let wret = 1 + (wcol - wcollatbasis)/wcollatbasis
        if (uret < config.TP_MAX_ROLL_LOSS ) { check = true  }// mark check positive 

        // TODO: relative index price rip: rint
    
        // update uret used by qrom holos check. Used at all?? rmv
        //mkt.uret = uret
        // compute uret based on current wcp  and basisCollateral
        //let tk = this.poolState[mkt.tkr].tick
        // use cumrefTick as markprice
        
        /*/let tk = this.poolState[mkt.tkr].cumulativeTick?.refCumTick
        if (mkt.startSize && mkt.openMark && tk) { 
            //markPnl = await this.getMarkPnl(mkt, tk) 
            // (collatbasis + markPnl - collatbasis)/collatbasis = 1 + markPnl/collatbasis
            mret = 1 + (wcol)/collatbasis
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
          */
          console.log(mkt.name + " ibasis:" + mkt.idxBasisCollateral.toFixed(2) + "idx uret: " + uret.toFixed(4) +
          " wret:" + wret.toFixed(4) + " wbasis:" + mkt.wBasisCollateral.toFixed(2));
    } 
    return check 
  }

  // chain scale reaction i.e scale causing additional scaleing
  async ratchedMaxLeverageTriggerCheck(market: Market) {
    const MAX_LEVERAGE = 10  //haircust will be applied
        if ( !(await this.isNonZeroPos(market)) ) {return}
    //TODO.OPTIMIZE remove perpnl not used
        //let perppnl = (await this.perpService.getUnrealizedPnl(market.wallet.address)).toNumber()
        let perpmr = await this.perpService.getMarginRatio(market.wallet.address)
        if (!perpmr) {  throw new Error(market.name + " FAIL: pmr null in maxMaxMarginRatioCheck")}

        if (config.TRACE_FLAG) { console.log("TRACE: " + market.name + " perpmr:" + perpmr.toFixed(4) 
                                    +  " maxmr:" + market.maxMarginRatio.toFixed(4) 
                                    +  " mrp: " + (10000*(market.maxMarginRatio - perpmr.toNumber())).toFixed() ) }
        //TODO.OPTIMIZE: if (perppnl < 0 ) { return }
    
        let freec = (await this.perpService.getFreeCollateral(market.wallet.address)).toNumber()
        if (freec < config.TP_MIN_FREE_COLLATERAL ) { return }
    
        // check if crossed threshold. two tracks regular track LEV_INC or fastrack to MAX_LEVERAGE
        if ( perpmr.toNumber() > market.maxMarginRatio ) {
            // scale to current maxMarginRatio. to get higher leverage. TODO: asses if better to use current mr at lower lvrj
            let scale = 1/market.maxMarginRatio
            //let scale = 1/market.basisMargin
            // check if I can fastract scale to MAX_LEVERAGE
            let urets = market.side == Side.LONG ? (await this.getOpenLegUrets()).uretLongs
                                                 : (await this.getOpenLegUrets()).uretShorts
            // do i have qrom of already same-side-opened profitable positions to fastract?
            if (urets.filter((uret) => uret > config.TP_QRM_MIN_RET).length >= config.TP_QRM_FOR_MAX_LEVERAGE) { 
                console.log(Date.now() + " INFO: SCALE 2 MAXMR " + market.name + " mr: ")
                scale = MAX_LEVERAGE }
            /*else { //snap, just the step increment
                let newmr = Math.max(market.basisMargin - config.TP_MARGIN_STEP_INC, 1/MAX_LEVERAGE)
                scale = 1/newmr
            }*/
            // ok. scale settled ready to opend
            let usdAmount = freec*scale*config.TP_EXECUTION_HAIRCUT
            try {  
                await this.open(market, usdAmount) 
                console.log(Date.now() + " INFO: SCALE " + market.name + " mr: " + perpmr.toFixed(4) +  
                                      " usdamnt: " + usdAmount.toFixed(4) + " freec: " + freec.toFixed(4)) 
            } catch { console.log(Date.now() + ", maxMargin Failed Open,  " +  market.name ) }
            // compute next maxMarginRatio: post scale mr + step increment
            let postscalemr = await this.perpService.getMarginRatio(market.wallet.address)
            if (postscalemr) {  
                market.maxMarginRatio = Math.min(postscalemr.toNumber() + config.TP_MARGIN_STEP_INC, 1)
            }
            else { // couldnt get current mr. keep both unchanged but warn
                console.log(Date.now() + " WARN: " + market.name + " FAIL: maxmarging unchaged. getMarginRatio null")
                console.log(Date.now() + " WARN: " + market.name + " scale failed. postcale margin: " + postscalemr )
            }
            //market.maxMarginRatio = Math.max(market.maxMarginRatio - config.TP_MARGIN_STEP_INC, 1/MAX_LEVERAGE)
            /*let postscalemr = await this.perpService.getMarginRatio(market.wallet.address)
            if (postscalemr) {  // mr should be lower than basis mr since we added freec to our position
                market.basisMargin = postscalemr.toNumber() 
                // update max margin increasing from latest basis with a max of 1 (no leverage)
                market.maxMarginRatio = Math.min(market.basisMargin + config.TP_MARGIN_STEP_INC, 1)
            }
            else { // couldnt get current mr. keep both unchanged but warn
                console.warn(Date.now() + " WARN: " + market.name + " FAIL: getMarginRatio null using")
                console.log(Date.now() + " WARN: " + market.name + " postcale margin: " + postscalemr )
            }*/
            // update basis margin. if null use 1/scale
        }
    }

async BKPratchedMaxLeverageTriggerCheck(market: Market) {
const MAX_LEVERAGE = 10  //haircust will be applied
    if ( !(await this.isNonZeroPos(market)) ) {return}

    let perppnl = (await this.perpService.getUnrealizedPnl(market.wallet.address)).toNumber()
    let perpmr = await this.perpService.getMarginRatio(market.wallet.address)
    if (!perpmr) {  throw new Error(market.name + " FAIL: pmr null in maxMaxMarginRatioCheck")}

    if (config.TRACE_FLAG) { console.log("TRACE: " + market.name + " perpmr:" + perpmr.toFixed(4) 
                                +  " maxmr:" + market.maxMarginRatio.toFixed(4) + " perppnl: " + perppnl.toFixed(4)) }
    //TODO.OPTIMIZE: if (perppnl < 0 ) { return }

    let freec = (await this.perpService.getFreeCollateral(market.wallet.address)).toNumber()
    if (freec < config.TP_MIN_FREE_COLLATERAL ) { return }

    // check if crossed threshold. two tracks regular track LEV_INC or fastrack to MAX_LEVERAGE
    if ( perpmr.toNumber() > market.maxMarginRatio ) {
        // Get the new scale: first check if normal INC or can fast track to MAX_LEVERAGE
        let scale = 1/market.basisMargin
        let urets = market.side == Side.LONG ? (await this.getOpenLegUrets()).uretLongs
                                             : (await this.getOpenLegUrets()).uretShorts
        // do i have qrom of already same-side-opened profitable positions to fastract?
        if (urets.filter((uret) => uret > config.TP_QRM_MIN_RET).length >= config.TP_QRM_FOR_MAX_LEVERAGE) { 
            console.log(Date.now() + " INFO: ACCEL2MAXMR " + market.name + " mr: ")
            scale = MAX_LEVERAGE }
        /*else { //snap, just the step increment
            let newmr = Math.max(market.basisMargin - config.TP_MARGIN_STEP_INC, 1/MAX_LEVERAGE)
            scale = 1/newmr
        }*/
        // ok. scale settled ready to open
        let usdAmount = freec*scale*config.TP_EXECUTION_HAIRCUT
        try {  // open at current leverage
            await this.open(market, usdAmount) 
            console.log(Date.now() + " INFO: SCALE " + market.name + " mr: " + perpmr.toFixed(4) +  
                                  " usdamnt: " + usdAmount.toFixed(4) + " freec: " + freec.toFixed(4)) 
        } catch { console.log(Date.now() + ", maxMargin Failed Open,  " +  market.name ) }
        // update basis = current mr and max = basis-decrement 
        let postscalemr = await this.perpService.getMarginRatio(market.wallet.address)
        if (postscalemr) {  // mr should be lower than basis mr since we added freec to our position
            market.basisMargin = postscalemr.toNumber() 
            // update max margin increasing from latest basis with a max of 1 (no leverage)
            market.maxMarginRatio = Math.min(market.basisMargin + config.TP_MARGIN_STEP_INC, 1)
        }
        else { // couldnt get current mr. keep both unchanged but warn
            console.warn(Date.now() + " WARN: " + market.name + " FAIL: getMarginRatio null using")
            console.log(Date.now() + " WARN: " + market.name + " postcale margin: " + postscalemr )
        }
        // update basis margin. if null use 1/scale
    }
}

  async kellyMaxLeverageTriggerCheck(market: Market) {

    if ( !(await this.isNonZeroPos(market)) ) {return}

    let perppnl = (await this.perpService.getUnrealizedPnl(market.wallet.address)).toNumber()
    let perpmr = await this.perpService.getMarginRatio(market.wallet.address)
    if (!perpmr) {  throw new Error(market.name + " FAIL: pmr null in maxMaxMarginRatioCheck")}

    //let idxPrice = (await this.perpService.getIndexPrice(market.baseToken)).toNumber()
    //let csz = (await this.perpService.getTotalPositionSize(market.wallet.address, market.baseToken)).toNumber()
    if (config.TRACE_FLAG) { 
        console.log("TRACE: " + market.name + " perpmr: " + perpmr.toFixed(4) +  " perppnl: " + perppnl.toFixed(4)) }
// if perppnl negative or too small freec for sure we are not scaling
    if (perppnl < 0 ) { return }
    let freec = (await this.perpService.getFreeCollateral(market.wallet.address)).toNumber()
    if (freec < config.TP_MIN_FREE_COLLATERAL ) { return }
/*
let nxtsz = (market.startCollateral + perppnl)/(market.resetMargin*idxPrice)
let incsz = nxtsz - Math.abs(csz)
let resetamnt = Math.abs(incsz)*idxPrice
// usdAmount will be the minimum of the reset amount and the free collateral
let usdAmount = Math.min(resetamnt, freec)*HAIRCUT
*/
// leverage level is determined by kelly. computeKelly return factor of max leverage
let kftors = await this.computeKellyLeverage()
// returns a number between 0 and 10*TP_EXECUTION_HAIRCUT
let klvrj = market.side == "long" ? kftors.longKellyLvrj : kftors.shortKellyLvrj
// note there is a floor on scale computed i.e 0.2
let scale = Math.max(klvrj, 1/market.resetMargin) //computeKellyLeverage can return a zero so we put a floor
let usdAmount = freec*scale*config.TP_EXECUTION_HAIRCUT
    if (perpmr.toNumber() > market.maxMarginRatio) {
        try { 
        await this.open(market, usdAmount) 
        console.log(Date.now() + " INFO: scale " + market.name + " mr: " + perpmr.toFixed(4) +  
                                  " usdamnt: " + usdAmount.toFixed(4) + " freec: " + freec.toFixed(4))
        } catch { console.log(Date.now() + ", maxMargin Failed Open,  " +  market.name )}
    }
}

async maxMaxMarginRatioCheck(market: Market) {
    if ( !(await this.isNonZeroPos(market)) ) {return}
    // compute current mr = [startcollat + pn]/sz*ipx
//W_END: hack    
    //let pnl = await this.getIdxBasedPnl(market)  <-- WRONG PNL AND CURR MR calculation
    let perppnl = (await this.perpService.getUnrealizedPnl(market.wallet.address)).toNumber()
    
    let perpmr = await this.perpService.getMarginRatio(market.wallet.address)
    // if pmr null then throw error
    if (!perpmr) { 
        console.log("FAIL: pmr null in maxMaxMarginRatioCheck")
        throw new Error("ERROR: pmr null in maxMaxMarginRatioCheck")
    }
//W_END: hack    
    let idxPrice = (await this.perpService.getIndexPrice(market.baseToken)).toNumber()
    let csz = (await this.perpService.getTotalPositionSize(market.wallet.address, market.baseToken)).toNumber()
    //let currMR = (market.startCollateral + pnl)/(csz *idxPrice )  <--- WRONG PNL AND CURR MR calculation
//if (config.TRACE_FLAG) { console.log("TRACE: " + market.name + " mr: " + currMR.toFixed(4) + " pnl: " + pnl.toFixed(4))}
if (config.TRACE_FLAG) { console.log("TRACE: " + market.name + " perpmr: " + perpmr.toFixed(4) + " perppnl: " + perppnl.toFixed(4))}
// if perppnl negative ret
if (perppnl < 0) { return }
let freec = (await this.perpService.getFreeCollateral(market.wallet.address)).toNumber()
const HAIRCUT = 0.975
const MIN_FREEC = 1 
if (freec < MIN_FREEC ) { 
    console.log("WARN: freec: " + market.name + ": " + freec.toFixed() + " too low in maxMaxMarginRatioCheck")
    return }

// compute size of position to RESET back: mr = [startcollat + pn]/sz*ipx => sz = [startcollat + pn]/mr/ipx
let nxtsz = (market.startCollateral + perppnl)/(market.resetMargin*idxPrice)
let incsz = nxtsz - Math.abs(csz)
let resetamnt = Math.abs(incsz)*idxPrice
// usdAmount will be the minimum of the reset amount and the free collateral
let usdAmount = Math.min(resetamnt, freec)*HAIRCUT
if (perpmr.toNumber() > market.maxMarginRatio) {
    //let usdAmount = config.TP_SCALE_FACTOR*Math.abs(csz)*idxPrice 
    try { await this.open(market, usdAmount) 
        console.log(Date.now() + " INFO: scale " + market.name + " mr: " + perpmr.toFixed(4) +  
                                  " usdamnt: " + usdAmount.toFixed() + " freec: " + freec.toFixed())
    }
    catch { console.log(Date.now() + ", maxMargin Failed Open,  " +  market.name )}
}
/* W_END: hack
if (currMR > market.maxMarginRatio) {
        let usdAmount = config.TP_SCALE_FACTOR*Math.abs(csz)*idxPrice 
        try { await this.open(market, usdAmount) 
            console.log(Date.now() + " INFO: scale " + market.name + " mr: " + currMR.toFixed(4) +  "usdamnt: " + usdAmount.toFixed())
        }
        catch { console.log(Date.now() + ", maxMargin Failed Open,  " +  market.name )}
    }*/

}


// FIXME: use the new way >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

async BKPmaxMaxMarginRatioCheck(market: Market) {
    // current marginratio = collat+upnl/positionVal. note collat + upnl == basisCollateral
    let pv = (await this.perpService.getTotalAbsPositionValue(market.wallet.address)).toNumber()
    let tick = this.poolState[market.tkr].tick
    // skip if no position
    if (pv == 0 || tick == 0) return
    let mr = market.idxBasisCollateral/pv
    if (mr > market.maxMarginRatio ){
    // compute additional size to bring down the margin ratio to reset value
    // mr = (collatBasis)/positionValue=positionSize*price => positionSize = collatBasis/price*mr
    
        let tickPrice = Math.pow(1.0001, tick!)
        let idxPrice = (await this.perpService.getIndexPrice(market.baseToken)).toNumber()
        let mktPrice = (await this.perpService.getMarketPrice(market.tkr)).toNumber()

    // tick price results in mr higher than reset. go for lowest price
    // BUG: pick min for long and max for short. for now just use the mark price
    let price = mktPrice

    let sz  = market.idxBasisCollateral/price*market.resetMargin
    // add to the position and recompute margin ratio
    await this.open(market, sz*price)

    pv = (await this.perpService.getTotalAbsPositionValue(market.wallet.address)).toNumber()
    let newmr = market.idxBasisCollateral/pv
    let tstmp = new Date().toLocaleTimeString([], {hour12: false, timeZone: 'America/New_York'});
    console.warn("mr trigger was based on index price")
    console.log(tstmp + " INFO: tick, indx, market Price: " + tickPrice + " " + idxPrice + " " + mktPrice)
    console.log(tstmp + " INFO: MARGIN RESET: " + market.name + " prv mr:" + mr.toFixed() + " nu mr:" + newmr.toFixed() + " sz:" + sz)
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
        console.log(Date.now() + this.ethService.provider.connection.url + ' INFO: Swap listeners reinstalled');
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
    //this.checkOnPoolSubEmptyBucket() //<========================== poolSubChecknPullBucket
//-------this.mktDirectionChangeCheck()  // asses direction. WAKEUP deps on this
      // MMR. maximum margin RESET check
    await this.ratchedMaxLeverageTriggerCheck(market) 
    //await this.maxMaxMarginRatioCheck(market)
    await this.wakeUpCheck(market) //wakeup only favored leg if sided mkt else both

  }
  //---------------- end of routine  -----------------------------------------------------
// last timestamp from routine, gets updated after this funcs completes
  evtNodeCheck(latestTimestamp: Timestamp) {
    //let reftkrs = ["vBTC", "vETH", "vAAVE", "vSOL", "vFLOW"];
    let now = Date.now();
    
    //for (let tkr of reftkrs) {
    for (let tkr of this.enabledMarkets) {    
      let latestEvt = this.evtBuffer[tkr].getLatest();
      if (latestEvt && latestEvt.timestamp > latestTimestamp) {
        latestTimestamp = latestEvt.timestamp;
      }
    }
    // if buffer empty. still rotate if time exceeds MON_MAX_TIME_WITH_NO_EVENTS_SEC
    let age = now - latestTimestamp
    //if (latestTimestamp == 0) return
      
    if ( age > config.MON_MAX_TIME_WITH_NO_EVENTS_SEC * 1000) {
        console.warn("WARN: " + (age/60000).toFixed() + " mins with no events. rotating provider");
        console.log("EVTMON: " + (age/60000).toFixed() + " mins with no events. rotating provider");
        this.evtRotateProvider()
    }
   }
    //DEPRECATED-----------------
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