import "reflect-metadata" // this shim is required

import { Log, initLog } from "@perp/common/build/lib/loggers"
import { Container } from "typedi"

import { Arbitrageur } from "./arbitrageur/Arbitrageur"

initLog()

export async function main(): Promise<void> {
    process.env["STAGE"] = "production"
    process.env["NETWORK"] = "optimism"

    // crash fast on uncaught errors
    const exitUncaughtError = async (err: any): Promise<void> => {
        const log = Log.getLogger("main")
        try {
            await log.jerror({
                event: "UncaughtException",
                params: {
                    err,
                },
            })
        } catch (e: any) {
            console.error(`exitUncaughtError error: ${e.toString()}`)
        }
        process.exit(1)
    }
    process.on("uncaughtException", err => exitUncaughtError(err))
    process.on("unhandledRejection", reason => exitUncaughtError(reason))

    
    const arbitrageur = Container.get(Arbitrageur)
    // install exit listeners to clean up
    //process.on("SIGINT", () => { console.log("Process is exiting..."); arbitrageur.genTWreport(); })
    //process.on("beforeExit", () => { console.log("Process is exiting..."); arbitrageur.genTWreport(); })
    //process.on("SIGINT", () => { console.log("Received SIGINT signal...");arbitrageur.genTWreport(); process.exit(0); })
    process.on("SIGINT", () => { console.log("INFO: Generating report..."); arbitrageur.genTWreport();})
    await arbitrageur.setup()
    await arbitrageur.start()
}

function exitRoutine(): void {
    //TODO: cleanup()
}
const isInLambda = !!process.env.LAMBDA_RUNTIME_DIR
if (require.main === module && !isInLambda) {
    main()
}
