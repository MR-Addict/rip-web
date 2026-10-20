import type { Page } from "@playwright/test";
// Replaces hardware only. The actual app Worker, decoder, calibration and controller run unchanged.
export async function installStationarySerial(page: Page) {
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        const bootstrap = `
          const waiting=[]; self.onmessage=e=>waiting.push(e);
          let input, sequence=0, tick=0;
          function reply(duty) {
            if(sequence%2===0)tick+=2000;
            const packet=new Uint8Array(45),v=new DataView(packet.buffer);
            packet.set([170,85,129,40]);v.setUint32(4,sequence++,true);
            const adc=1900+sequence%3;
            [duty,adc*360/4095-180,70,0,0,70,0].forEach((x,i)=>v.setFloat32(8+i*4,x,true));
            v.setUint32(36,tick,true);v.setUint32(40,adc,true);
            let crc=0;for(const b of packet.subarray(2,44)){crc^=b;for(let i=0;i<8;i++)crc=((crc<<1)^(crc&128?7:0))&255;}
            packet[44]=crc;input.enqueue(packet);
          }
          const port={open:async()=>{},close:async()=>{},getInfo:()=>({usbVendorId:1155,usbProductId:22336}),
            readable:new ReadableStream({start(c){input=c;}}),
            writable:new WritableStream({write(bytes){const v=new DataView(bytes.buffer,bytes.byteOffset);reply(v.getFloat32(8,true));}})};
          Object.defineProperty(navigator,'serial',{value:{getPorts:async()=>[port],addEventListener:()=>{}}});
          await import(${JSON.stringify(String(url))});
          for(const e of waiting)self.onmessage(e);
        `;
        super(
          URL.createObjectURL(
            new Blob([bootstrap], { type: "text/javascript" }),
          ),
          options,
        );
      }
    };
  });
}
