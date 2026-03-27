import * as vscode from "vscode";

export class OrbSidebarProvider implements vscode.WebviewViewProvider {

  public static readonly viewType = "orbSidebar";

  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView
  ): Thenable<void> | void {

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };

    webviewView.webview.html = this.getHtml();

  }

  public sendData(data:any){

    this._view?.webview.postMessage({

      type: "orb-data",
      payload: data

    });

  }

  private getHtml(){

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 16px;
            margin: 0;
            color: var(--vscode-editor-foreground);
          }
          h2 {
            margin: 0 0 16px 0;
            font-size: 18px;
          }
          .section {
            margin-bottom: 20px;
          }
          .section-title {
            font-weight: 600;
            margin-bottom: 10px;
            font-size: 13px;
            text-transform: uppercase;
            opacity: 0.8;
          }
          .qr-container {
            text-align: center;
            padding: 20px;
            background-color: var(--vscode-input-background);
            border-radius: 4px;
          }
          #qrcode {
            display: inline-block;
            margin: 0 auto;
          }
          .description {
            font-size: 12px;
            opacity: 0.7;
            margin-top: 8px;
          }
          .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            border-radius: 3px;
            font-size: 12px;
            margin-top: 8px;
          }
          .status-badge.connected {
            background-color: rgba(14, 168, 0, 0.15);
            color: #0ea800;
          }
          .status-badge.disconnected {
            background-color: rgba(252, 78, 95, 0.15);
            color: #fc4e5f;
          }
          .dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background-color: currentColor;
          }
          #output {
            margin: 0;
            padding: 8px;
            font-size: 11px;
            background-color: var(--vscode-input-background);
            border-radius: 2px;
            color: var(--vscode-editor-foreground);
            white-space: pre-wrap;
            word-wrap: break-word;
            max-height: 150px;
            overflow-y: auto;
          }
        </style>
      </head>
      <body>
        <h2>Orb DevKit</h2>
        
        <div class="section">
          <div class="status-badge disconnected" id="connectionStatus">
            <span class="dot"></span>
            <span id="statusText">Connecting...</span>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Pair Device</div>
          <div class="qr-container">
            <div id="qrcode"></div>
            <div class="description">Scan with your mobile device to pair</div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Daemon Status</div>
          <pre id="output">Loading...</pre>
        </div>

        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode.js/1.5.3/qrcode.min.js"><\/script>
        <script>
          try {
            const vscode = acquireVsCodeApi();
            
            // Generate mock pairing token
            const pairingToken = 'orb-pair-' + Math.random().toString(36).substring(2, 15);
            
            // Generate QR code with error handling
            try {
              const qrcodeContainer = document.getElementById('qrcode');
              new QRCode(qrcodeContainer, {
                text: pairingToken,
                width: 150,
                height: 150,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.H
              });
            } catch (e) {
              console.error('QR Code generation error:', e);
              document.getElementById('qrcode').textContent = '(QR code unavailable)';
            }

            window.addEventListener('message', event => {
              const message = event.data;
              if (message.type === 'orb-data') {
                const status = message.payload.status || 'disconnected';
                const statusBadge = document.getElementById('connectionStatus');
                const statusText = document.getElementById('statusText');
                
                if (status === 'connected') {
                  statusBadge.className = 'status-badge connected';
                  statusText.textContent = 'Connected to orb-daemon';
                } else {
                  statusBadge.className = 'status-badge disconnected';
                  statusText.textContent = 'Disconnected from orb-daemon';
                }

                document.getElementById('output').textContent = JSON.stringify(message.payload, null, 2);
              }
            });
          } catch (e) {
            console.error('Sidebar error:', e);
            document.getElementById('output').textContent = 'Error: ' + e.message;
          }
        <\/script>
      </body>
      </html>
    `;

  }

}