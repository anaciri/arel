import { Signer } from "@ethersproject/abstract-signer";
import { Block, StaticJsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { Big } from "big.js";
import { ContractInterface, Wallet } from "ethers";
import { Log } from "../loggers";
import { LayerType } from "../types";
export declare class EthService {
    readonly layer: LayerType;
    readonly web3Endpoints: string[];
    readonly log: Log;
    protected web3EndpointsIndex: number;
    provider: StaticJsonRpcProvider | WebSocketProvider;
    constructor(layer: LayerType, web3Endpoints: string[]);
    protected static providerFactory(endpoint: string): StaticJsonRpcProvider | WebSocketProvider;
    static isWebSocketEndpoint(endpoint: string): boolean;
    privateKeyToWallet(privateKey: string): Wallet;
    createContract<T>(address: string, abi: ContractInterface, signer?: Signer): T;
    getGasPrice(): Promise<Big>;
    enableEndpointRotation(callback?: NewBlockCallback | undefined): Promise<void>;
    subscribeToNewBlocks(callback: NewBlockCallback): void;
    aybSetProvider(toEndpoint: string): void;
    rotateToNextEndpoint(callback?: NewBlockCallback | undefined): void;
    destroy(): void;
    getBlock(blockNumber: number): Promise<Block>;
    getBlocks(blockNumbers: number[]): Promise<Record<number, Block>>;
    getLatestBlockNumber(): Promise<number>;
    checkBlockNumberWithLatency(): Promise<{
        blockNumber: number;
        latency: number;
    }>;
}
export declare type NewBlockCallback = (blockNumber: number) => void;
//# sourceMappingURL=EthService.d.ts.map