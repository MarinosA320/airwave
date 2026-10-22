// Airwave toolbar panel. The panel itself is a page served by Airwave Pilot on this computer,
// so everything (frequency, ATC instructions, read back) comes from the app; this file only frames it.
const AIRWAVE_URL = 'http://localhost:8090/panel';

class AirwavePilotPanel extends TemplateElement {
    connectedCallback() {
        super.connectedCallback();
        this.ui = this.querySelector('ingame-ui');
        this.frame = this.querySelector('#AirwaveFrame');
        this.waiting = this.querySelector('#AirwaveWaiting');
        this.timer = null;
        if (!this.ui) return;
        this.ui.addEventListener('panelActive', () => this.open());
        this.ui.addEventListener('panelInactive', () => this.close());
    }
    // Only load the page once Airwave Pilot answers, and show a hint until then.
    open() {
        this.close();
        const check = () => {
            const x = new XMLHttpRequest();
            x.open('GET', 'http://localhost:8090/api/panel', true);
            x.timeout = 2000;
            x.onload = () => {
                if (x.status !== 200) return retry();
                this.waiting.style.display = 'none';
                this.frame.style.display = 'block';
                if (!this.frame.src || this.frame.src.indexOf(AIRWAVE_URL) < 0) this.frame.src = AIRWAVE_URL;
            };
            x.onerror = x.ontimeout = retry;
            x.send();
        };
        const retry = () => {
            this.frame.style.display = 'none';
            this.waiting.style.display = 'block';
            this.waiting.textContent = 'Airwave Pilot is not running. Start it from the Airwave Pilot shortcut on your desktop; this panel connects by itself.';
            this.timer = setTimeout(check, 3000);
        };
        check();
    }
    close() {
        clearTimeout(this.timer);
        if (this.frame) { this.frame.src = ''; this.frame.style.display = 'none'; }
    }
}
window.customElements.define('airwave-pilot-panel', AirwavePilotPanel);
checkAutoload();
