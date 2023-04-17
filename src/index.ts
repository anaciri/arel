import "reflect-metadata" // this shim is required
import { Log, initLog } from "@perp/common/build/lib/loggers"
import { Container } from "typedi"
import { Arbitrageur } from "./arbitrageur/Arbitrageur"
initLog()
import { Command } from 'commander';



export async function main(): Promise<void> {
    // initialize: env necessary to point to right metadata
    process.env["STAGE"] = "production"
    process.env["NETWORK"] = "optimism"
    const cli = Container.get(Arbitrageur)
    await cli.setup() // add all universe of tkrs
    await cli.start() 

    const program = new Command();
    program
      .command('usdbalance <mkt>')
      .description('get USDC balance')
      .action(async (mkt: string) => {
        //----------- get balance ----------------
        let market = cli.marketMap[mkt]
        let addr = market.wallet.address
        let balance = await cli.getUSDCbalance(market)
        console.log(`Balance for ${mkt}: ${addr}: ${balance}`);
    
      });
  
    program
      .command('approve <address>')
      .description('approve USDC spending')
      .action((address: string) => {
        console.log(`Approve address ${address}`);
      });
  
    program
      .command('deposit <address> <amount>')
      .description('Deposit an amount to an address')
      .action((address: string, amount: string) => {
        console.log(`Depositing ${amount} to address ${address}`);
      });
  
    program
      .command('help')
      .description('Display list of commands')
      .action(() => {
        program.outputHelp();
      });
  
    program.parse(process.argv);
  
    if (!process.argv.slice(2).length) {
      program.outputHelp();
    }
  }
  
  main();
  