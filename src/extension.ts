import * as vscode from "vscode";
import { OrbSidebarProvider } from "./OrbSidebarProvider";
import net from "net";

export function activate(context: vscode.ExtensionContext) {

  console.log("Orb extension activating...");

  const sidebarProvider = new OrbSidebarProvider(
    context.extensionUri
  );

  const registration = vscode.window.registerWebviewViewProvider(
    OrbSidebarProvider.viewType,
    sidebarProvider,
    {
      webviewOptions: { retainContextWhenHidden: true }
    }
  );

  context.subscriptions.push(registration);

  console.log("Orb sidebar provider registered");

  connectOrbDaemon(sidebarProvider);

}

function connectOrbDaemon(
  sidebar: OrbSidebarProvider
){

  const client = new net.Socket();

  client.connect(

    3131,
    "127.0.0.1",

    () => {

      console.log("Connected to orb-daemon");

      sidebar.sendData({

        status: "connected"

      });

    }

  );

  client.on("data", (data) => {

    try{

      const parsed = JSON.parse(
        data.toString()
      );

      sidebar.sendData(parsed);

    }catch{

      sidebar.sendData({

        raw: data.toString()

      });

    }

  });

  client.on("error", () => {

    sidebar.sendData({

      status: "orb-daemon offline"

    });

  });

}

export function deactivate(){}