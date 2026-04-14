var S=Object.defineProperty;var C=(e,n,o)=>n in e?S(e,n,{enumerable:!0,configurable:!0,writable:!0,value:o}):e[n]=o;var h=(e,n,o)=>C(e,typeof n!="symbol"?n+"":n,o);const _="nextcard-sync-overlay",L=chrome.runtime.getURL("src/icons/icon128.png");let i=null,s=null,l=null,a=null,u=null;function T(e){switch(e){case"waiting_for_login":return{heading:"nextcard is waiting for you to sign in",steps:["Sign in to your account as you normally would","Once logged in, we'll read your data automatically","<strong>Don't close or navigate away from this tab</strong>"],dotClass:"dot-waiting",showShield:!0};case"extracting":return{heading:"nextcard is reading your account",steps:["Pulling your balances, status, and benefits","<strong>Don't click anything, close, or leave this page</strong>","This usually takes a few seconds"],dotClass:"dot-extracting",showShield:!1};case"done":return{heading:"All synced!",steps:[],dotClass:"dot-done",showShield:!1};case"error":return{heading:"Something went wrong",steps:["Try syncing again from the nextcard sidebar"],dotClass:"dot-error",showShield:!1};case"cancelled":return{heading:"Sync cancelled",steps:[],dotClass:"dot-error",showShield:!1}}}const A=`
  :host {
    all: initial;
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    font-family: "Nunito", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  :host(.nc-fade-out) .nc-backdrop {
    animation: nc-fade-out 0.35s ease-in forwards;
  }

  :host(.nc-fade-out) .nc-banner {
    animation: nc-banner-out 0.35s ease-in forwards;
  }

  /* ── Backdrop ── */

  .nc-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    pointer-events: none;
    animation: nc-backdrop-in 0.3s ease-out;
  }

  :host(.nc-login) {
    align-items: flex-end;
    padding: 0 16px 24px;
  }

  :host(.nc-login) .nc-backdrop {
    display: none;
  }

  @keyframes nc-backdrop-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  @keyframes nc-slide-down {
    from { opacity: 0; transform: translateY(-20px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  @keyframes nc-fade-out {
    from { opacity: 1; }
    to   { opacity: 0; }
  }

  @keyframes nc-banner-out {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to   { opacity: 0; transform: translateY(-12px) scale(0.97); }
  }

  .nc-banner {
    position: relative;
    display: flex;
    gap: 14px;
    background: #fefefe;
    color: #342019;
    pointer-events: auto;
    padding: 16px 20px;
    border-radius: 16px;
    box-shadow:
      0 12px 40px rgba(0, 0, 0, 0.2),
      0 4px 12px rgba(0, 0, 0, 0.1);
    max-width: 440px;
    width: calc(100% - 32px);
    border: 1px solid #f0ece8;
    animation: nc-slide-down 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }

  /* ── Logo ── */

  .nc-logo {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    object-fit: contain;
  }

  /* ── Body ── */

  .nc-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }

  .nc-heading {
    font-size: 13.5px;
    font-weight: 700;
    color: #342019;
    display: flex;
    align-items: center;
    gap: 8px;
    letter-spacing: -0.2px;
    line-height: 1.2;
  }

  /* ── Status dot ── */

  .nc-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .dot-waiting {
    background: #f6b156;
    animation: nc-pulse 1.5s ease-in-out infinite;
  }

  .dot-extracting {
    background: #f6b156;
    animation: nc-pulse 0.9s ease-in-out infinite;
  }

  .dot-done {
    background: #34c759;
  }

  .dot-error {
    background: #ff3b30;
  }

  @keyframes nc-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.25; }
  }

  /* ── Step list ── */

  .nc-steps {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .nc-steps:empty { display: none; }

  .nc-step {
    font-size: 12px;
    font-weight: 400;
    color: #8c7a6e;
    line-height: 1.45;
    padding-left: 14px;
    position: relative;
  }

  .nc-step::before {
    content: "";
    position: absolute;
    left: 0;
    top: 6.5px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #d0c8c0;
  }

  .nc-step strong {
    color: #342019;
    font-weight: 700;
  }

  /* ── Shield line ── */

  .nc-shield {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    font-size: 11px;
    color: #b0a49a;
    line-height: 1.3;
  }

  .nc-shield:empty { display: none; }

  .nc-shield svg {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    color: #b0a49a;
  }

  /* ── Progress bar (extracting only) ── */

  .nc-progress {
    height: 3px;
    border-radius: 2px;
    background: #f0ece8;
    overflow: hidden;
    margin-top: 2px;
  }

  .nc-progress:empty { display: none; }

  .nc-progress-bar {
    height: 100%;
    border-radius: 2px;
    background: #f6b156;
    animation: nc-indeterminate 1.8s ease-in-out infinite;
    width: 40%;
  }

  @keyframes nc-indeterminate {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
  }
`,I=`<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M6 1L2 3v2.5c0 2.73 1.7 5.28 4 6 2.3-.72 4-3.27 4-6V3L6 1z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>
  <path d="M4.5 6.25L5.5 7.25 7.5 5" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;function x(e){const n=T(e),o=n.steps.length?`<ul class="nc-steps">${n.steps.map(r=>`<li class="nc-step">${r}</li>`).join("")}</ul>`:"",c=n.showShield?`<div class="nc-shield">${I} nextcard never sees or stores your login credentials</div>`:"",g=e==="extracting"?'<div class="nc-progress"><div class="nc-progress-bar"></div></div>':"",d=`<img class="nc-logo" src="${L}" alt="nextcard" />`;return`
    <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet"/>
    <style>${A}</style>
    <div class="nc-backdrop"></div>
    <div class="nc-banner">
      ${d}
      <div class="nc-body">
        <div class="nc-heading">
          <span class="nc-dot ${n.dotClass}"></span>
          ${n.heading}
        </div>
        ${o}
        ${g}
        ${c}
      </div>
    </div>
  `}function R(e){if(document.body)requestAnimationFrame(()=>document.body.appendChild(e));else{const n=new MutationObserver(()=>{document.body&&(n.disconnect(),requestAnimationFrame(()=>document.body.appendChild(e)))});n.observe(document.documentElement,{childList:!0})}}function m(){const e=u;!e||l||(l=setInterval(()=>{chrome.runtime.sendMessage({type:"GET_PROVIDER_STATUS",provider:e},n=>{if(chrome.runtime.lastError)return;const o=n==null?void 0:n.status;o==="extracting"&&a!=="extracting"?f("extracting"):o==="waiting_for_login"&&a!=="waiting_for_login"?f("waiting_for_login"):o==="done"?y("done"):(o==="error"||o==="cancelled")&&y(o==="error"?"error":"cancelled")})},2e3))}function $(e,n){if(n&&(u=n),i){f(e,n);return}i=document.createElement("div"),i.id=_,e==="waiting_for_login"&&i.classList.add("nc-login"),s=i.attachShadow({mode:"closed"}),s.innerHTML=x(e),a=e,R(i),m()}function f(e,n){if(n&&(u=n),!s||!i){$(e,n);return}if(e===a){m();return}e==="waiting_for_login"?i.classList.add("nc-login"):i.classList.remove("nc-login"),s.innerHTML=x(e),a=e,m()}function y(e="done"){l&&(clearInterval(l),l=null),!(!s||!i)&&(f(e),setTimeout(()=>{i&&(i.classList.add("nc-fade-out"),setTimeout(()=>{i==null||i.remove(),i=null,s=null,a=null,u=null},350))},e==="done"?1500:800))}class E extends Error{constructor(o,c){super(`Content script run cancelled for ${o}`);h(this,"provider");h(this,"attemptId");this.name="ContentScriptRunCancelledError",this.provider=o,this.attemptId=c}}function O(e){let n=null;const o=new Set;function c(t){return!t||typeof t!="object"||!("type"in t)||!("provider"in t)||!("attemptId"in t)?!1:t.type==="ABORT_SYNC_RUN"&&t.provider===e&&typeof t.attemptId=="string"}function g(t){n=t,o.delete(t)}function d(t){return n===t&&!o.has(t)}function r(t){if(!d(t))throw new E(e,t)}async function b(t,p){r(p),await new Promise(k=>{setTimeout(k,t)}),r(p)}async function w(t,p){r(t),await chrome.runtime.sendMessage({...p,provider:e,attemptId:t})}function v(t){return c(t)?(o.add(t.attemptId),n===t.attemptId&&(n=null,y("cancelled")),!0):!1}return{beginAttempt:g,handleAbort:v,isAttemptActive:d,throwIfCancelled:r,sleep:b,sendMessage:w}}export{O as c,y as h,$ as s,f as u};
