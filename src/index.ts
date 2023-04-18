import "reflect-metadata" // this shim is required
import { Log, initLog } from "@perp/common/build/lib/loggers"
import { Container } from "typedi"
import { Arbitrageur } from "./arbitrageur/Arbitrageur"
initLog()
import { Command } from 'commander';
import Big from "big.js"




export async function main(): Promise<void> {
    // move to config
    const MAX_TRANSFER_APPROVAL = 200

    // initialize: env necessary to point to right metadata
    process.env["STAGE"] = "production"
    process.env["NETWORK"] = "optimism"
    const cli = Container.get(Arbitrageur)
    await cli.setup() // add all universe of tkrs
    await cli.start() 

    const program = new Command();
    program
      .command('usdbal <mkt>')
      .description('get USDC balance')
      .action(async (mkt: string) => {
        //----------- get balance ----------------
        let market = cli.marketMap[mkt]
        let addr = market.wallet.address
        let balance = await cli.getUSDCbalance(market)
        console.log(`Balance for ${mkt}: ${addr}: ${balance}`);
      });

      program
      .command('colval <mkt>')
      .description('collateral value')
      .action(async (mkt: string) => {
        let market = cli.marketMap[mkt]
        let addr = market.wallet.address
        let val = (await cli.perpService.getAccountValue(market.wallet.address)).toFixed(4)
        console.log(`${mkt}: ${val}`);
      });  
  
    program
      .command('approve <mkt, amount>')
      .description('approve USDC spending')
      .action(async (mkt: string) => {
        //----------- approve ----------------
        let market = cli.marketMap[mkt]
        //let addr = market.wallet.address
        await cli.approve(market.wallet, Big(MAX_TRANSFER_APPROVAL))
        console.log(`Approve address ${mkt} for ${MAX_TRANSFER_APPROVAL}`);
      });
  
      program
      .command('deposit <mkt, amount>')
      .description('deposit USDC')
      .action(async (mkt: string, amount: string) => {
        //----------- deposit ----------------
        let market = cli.marketMap[mkt]
        let amnt = program.args[1] 
        console.log(amount)
        await cli.deposit(market.wallet, Big(amnt))
        console.log(`Deposited address ${mkt}`);
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


    //------------ DEBUG CODE: REMOVE ME @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&
   /*
    try {
        // Call usdbal command
        let bal = await program.parseAsync(['', '', 'usdbal', 'vSOL_SHORT']);

        // Call approve command
//        await program.parseAsync(['', '', 'approve', 'vSOL_SHORT', `${MAX_TRANSFER_APPROVAL}`]);

        // Call deposit command
        await program.parseAsync(['', '', 'deposit', 'vSOL_SHORT', '8']);

        // Call colval command
       let coval =  await program.parseAsync(['', '', 'colval', 'vSOL_SHORT']);
    } catch (error) {
        console.error(error);
    }
    */
  }
  
  main();
  