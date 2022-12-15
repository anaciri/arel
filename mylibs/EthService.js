"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var EthService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EthService = void 0;
const providers_1 = require("@ethersproject/providers");
const big_js_1 = require("big.js");
const ethers_1 = require("ethers");
const typedi_1 = require("typedi");
const helper_1 = require("../helper");
const loggers_1 = require("../loggers");
const types_1 = require("../types");
let EthService = EthService_1 = class EthService {
    layer;
    web3Endpoints;
    log = loggers_1.Log.getLogger(EthService_1.name);
    web3EndpointsIndex = 0;
    // TODO: currently only Alchemy provides ws endpoint for Arbitrum
    // Offchain Labs and Infura only provide RPC endpoint
    // provider!: WebSocketProvider
    provider;
    constructor(layer, web3Endpoints) {
        this.layer = layer;
        this.web3Endpoints = web3Endpoints;
        // use random endpoint here to prevent the first endpoint died and program crash before endpoint rotation
        this.web3EndpointsIndex = helper_1.getRandomInt(this.web3Endpoints.length);
        const web3Endpoint = web3Endpoints[this.web3EndpointsIndex];
        if (!web3Endpoint) {
            throw Error("web3 endpoint not found");
        }
        this.log.jinfo({
            event: "InitEthServiceProvider",
            params: {
                layer,
                web3Endpoints,
            },
        });
        this.provider = EthService_1.providerFactory(web3Endpoint);
    }
    static providerFactory(endpoint) {
        return EthService_1.isWebSocketEndpoint(endpoint)
            ? new providers_1.WebSocketProvider(endpoint)
            : new providers_1.StaticJsonRpcProvider({ url: endpoint, timeout: 120 * 1000 });
    }
    static isWebSocketEndpoint(endpoint) {
        return endpoint.startsWith("wss://");
    }
    privateKeyToWallet(privateKey) {
        return new ethers_1.ethers.Wallet(privateKey, this.provider);
    }
    createContract(address, abi, signer) {
        return new ethers_1.ethers.Contract(address, abi, signer ? signer : this.provider);
    }
    async getGasPrice() {
        return big_js_1.Big(ethers_1.ethers.utils.formatUnits(await this.provider.getGasPrice(), "gwei"));
    }
    async enableEndpointRotation(callback = undefined) {
        const HEALTH_CHECK_INTERVAL_MSEC = 10 * 1000;
        const MAX_ACCEPTABLE_LATENCY_MSEC = 60 * 1000;
        while (true) {
            const endpoint = this.provider.connection.url;
            try {
                const { latency } = await this.checkBlockNumberWithLatency();
                //TODO.STK endpoint health monitoring
                //this.log.jinfo({ event: `EndpointHealthCheckRoutineAlive`, params: { endpoint, latency } });
                if (latency > MAX_ACCEPTABLE_LATENCY_MSEC) {
                    this.rotateToNextEndpoint(callback);
                }
            }
            catch (err) {
                await this.log.jerror({
                    event: "EndpointHealthCheckError",
                    params: { endpoint, err },
                });
                this.rotateToNextEndpoint(callback);
            }
            await helper_1.sleep(HEALTH_CHECK_INTERVAL_MSEC);
        }
    }
    subscribeToNewBlocks(callback) {
        this.log.jinfo({ event: "SubScribeToNewBlocks", params: { endpoint: this.provider.connection.url } });
        this.provider.on("block", (blockNumber) => {
            this.log.jinfo({
                event: "NewBlock",
                params: { endpoint: this.provider.connection.url, blockNumber },
            });
            callback(blockNumber);
        });
        this.provider.on("error", err => {
            this.log.jerror({
                event: "NewBlockSubscriptionError",
                params: { endpoint: this.provider.connection.url, err },
            });
        });
    }
    rotateToNextEndpoint(callback = undefined) {
        this.destroy();
        const fromEndpoint = this.provider.connection.url;
        this.web3EndpointsIndex = (this.web3EndpointsIndex + 1) % this.web3Endpoints.length;
        const toEndpoint = this.web3Endpoints[this.web3EndpointsIndex];
        this.log.jinfo({
            event: "RotateWeb3Endpoint",
            params: { fromEndpoint, toEndpoint },
        });
        this.provider = EthService_1.providerFactory(toEndpoint);
        if (callback) {
            this.subscribeToNewBlocks(callback);
        }
    }
    destroy() {
        this.provider.removeAllListeners();
        if (this.provider instanceof providers_1.WebSocketProvider) {
            this.provider.destroy();
        }
    }
    async getBlock(blockNumber) {
        return await this.provider.getBlock(blockNumber);
    }
    async getBlocks(blockNumbers) {
        const blocksMap = {};
        await Promise.all(blockNumbers.map(async (blockNumber) => {
            blocksMap[blockNumber] = await this.getBlock(blockNumber);
        }));
        return blocksMap;
    }
    async getLatestBlockNumber() {
        return await this.provider.getBlockNumber();
    }
    async checkBlockNumberWithLatency() {
        const startTime = Date.now();
        const blockNumber = await this.getLatestBlockNumber();
        const latency = Date.now() - startTime;
        return { blockNumber, latency };
    }
};
EthService = EthService_1 = __decorate([
    typedi_1.Service(),
    __metadata("design:paramtypes", [String, Array])
], EthService);
exports.EthService = EthService;
//# sourceMappingURL=EthService.js.map