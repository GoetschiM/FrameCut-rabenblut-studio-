"""Generate one H3 shot with native stereo audio through the ComfyUI API."""
import argparse, json, time, uuid, urllib.request, urllib.parse
from pathlib import Path

def main():
    p=argparse.ArgumentParser()
    for arg in ['base-url','image','prompt-file','output-dir','name']:
        p.add_argument('--'+arg,required=True)
    p.add_argument('--width',type=int,default=608)
    p.add_argument('--height',type=int,default=352)
    p.add_argument('--frames',type=int,default=124)
    p.add_argument('--steps',type=int,default=4)
    p.add_argument('--seed',type=int,default=9421201)
    p.add_argument('--low-vram',action='store_true')
    p.add_argument('--crop',nargs=4,type=int,metavar=('X','Y','WIDTH','HEIGHT'))
    p.add_argument('--reference-image',action='append',default=[])
    a=p.parse_args()
    assert a.width%32==0 and a.height%32==0 and (a.frames-5)%17==0
    out=Path(a.output_dir);out.mkdir(parents=True,exist_ok=True)
    statepath=out/(a.name+'.state.json')
    if statepath.exists():
        raise RuntimeError('Existing job state; inspect history instead of submitting again: '+str(statepath))
    base=a.base_url.rstrip('/')
    def api(route,data=None):
        req=urllib.request.Request(base+route,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=120) as r:return json.load(r)
    image=Path(a.image);boundary=uuid.uuid4().hex
    filename='rabenblut_'+boundary+image.suffix
    body=(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{filename}"\r\nContent-Type: image/png\r\n\r\n').encode()+image.read_bytes()+f'\r\n--{boundary}--\r\n'.encode()
    req=urllib.request.Request(base+'/upload/image',data=body,headers={'Content-Type':'multipart/form-data; boundary='+boundary})
    with urllib.request.urlopen(req,timeout=120) as r:uploaded=json.load(r)
    prompt=Path(a.prompt_file).read_text(encoding='utf-8')
    g={
      'clip':{'class_type':'CLIPLoader','inputs':{'clip_name':'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors','type':'minimax','device':'default'}},
      'vae':{'class_type':'VAELoader','inputs':{'vae_name':'minimax_h3_video_vae_fp16.safetensors'}},
      'avae':{'class_type':'VAELoader','inputs':{'vae_name':'minimax_h3_audio_vae_fp32.safetensors'}},
      'unet':{'class_type':'UNETLoader','inputs':{'unet_name':'minimax_h3_fl2va_pruned_int8_convrot.safetensors','weight_dtype':'default'}},
      'lora':{'class_type':'MiniMaxH3TurboLoRA','inputs':{'model':['unet',0],'lora_name':'minimax_h3_turbo_v4_step600_ema.safetensors','strength':1.0,'low_vram':a.low_vram}},
      'image':{'class_type':'LoadImage','inputs':{'image':uploaded['name']}},
      'cond':{'class_type':'MiniMaxH3ImageToVideo','inputs':{'clip':['clip',0],'vae':['vae',0],'prompt':prompt,'width':a.width,'height':a.height,'length':a.frames,'first_frame':['image',0]}},
      'guide':{'class_type':'BasicGuider','inputs':{'model':['lora',0],'conditioning':['cond',0]}},
      'sig':{'class_type':'BasicScheduler','inputs':{'model':['lora',0],'scheduler':'simple','steps':a.steps,'denoise':1.0}},
      'sampler':{'class_type':'MiniMaxH3TurboSampler','inputs':{}},
      'noise':{'class_type':'RandomNoise','inputs':{'noise_seed':a.seed}},
      'run':{'class_type':'SamplerCustomAdvanced','inputs':{'noise':['noise',0],'guider':['guide',0],'sampler':['sampler',0],'sigmas':['sig',0],'latent_image':['cond',1]}},
      'decode':{'class_type':'VAEDecode','inputs':{'samples':['run',0],'vae':['vae',0]}},
      'decode_audio':{'class_type':'VAEDecodeAudio','inputs':{'samples':['run',0],'vae':['avae',0]}},
      'video':{'class_type':'CreateVideo','inputs':{'images':['decode',0],'audio':['decode_audio',0],'fps':24.0}},
      'save':{'class_type':'SaveVideo','inputs':{'video':['video',0],'filename_prefix':'rabenblut/film_v2/'+a.name,'format':'mp4','codec':'h264'}}
    }
    if a.crop:
        x,y,w,h=a.crop
        g['crop']={'class_type':'ImageCrop','inputs':{'image':['image',0],'x':x,'y':y,'width':w,'height':h}}
        g['cond']['inputs']['first_frame']=['crop',0]
    if a.reference_image:
        g['unet']['inputs']['unet_name']='minimax_h3_ref2va_pruned_int8_convrot.safetensors'
        # ReferenceToVideo has no first_frame input.  Feeding the scene keyframe into
        # ref_image_0 therefore made model sheets leak into frame 0.  Keep the scene
        # frame as an explicit Guide, and reserve the reference channel for identity.
        g['cond']={'class_type':'MiniMaxH3ReferenceToVideo','inputs':{'clip':['clip',0],'vae':['vae',0],'audio_vae':['avae',0],'prompt':prompt,'width':a.width,'height':a.height,'length':a.frames,'ref_image_size':'max'}}
        for index,refpath in enumerate(a.reference_image):
            ref=Path(refpath);rb=uuid.uuid4().hex
            rbbody=(f'--{rb}\r\nContent-Disposition: form-data; name="image"; filename="rb_{rb}.png"\r\nContent-Type: image/png\r\n\r\n').encode()+ref.read_bytes()+f'\r\n--{rb}--\r\n'.encode()
            request=urllib.request.Request(base+'/upload/image',data=rbbody,headers={'Content-Type':'multipart/form-data; boundary='+rb})
            with urllib.request.urlopen(request,timeout=120) as r:refmeta=json.load(r)
            key='reference_'+str(index)
            g[key]={'class_type':'LoadImage','inputs':{'image':refmeta['name']}}
            g['cond']['inputs']['ref_images.ref_image_'+str(index)]=[key,0]
        g['anchor']={'class_type':'MiniMaxH3AddGuide','inputs':{'positive':['cond',0],'latent':['cond',1],'frame_idx':0,'vae':['vae',0],'audio_vae':['avae',0],'image':['image',0]}}
        g['guide']['inputs']['conditioning']=['anchor',0]
        g['run']['inputs']['latent_image']=['anchor',1]
    (out/(a.name+'.workflow.json')).write_text(json.dumps(g,indent=2),encoding='utf-8')
    result=api('/prompt',{'prompt':g,'client_id':'rabenblut-film-v2'})
    state={'prompt_id':result['prompt_id'],'input':str(image.resolve()),'prompt':prompt,'settings':vars(a),'status':'queued'}
    statepath.write_text(json.dumps(state,indent=2),encoding='utf-8')
    print('QUEUED '+a.name+' '+state['prompt_id'],flush=True)
    started=time.time()
    while time.time()-started<7200:
        record=api('/history/'+state['prompt_id']).get(state['prompt_id'])
        if record:
            (out/(a.name+'.history.json')).write_text(json.dumps(record,indent=2),encoding='utf-8')
            status=record.get('status',{}).get('status_str')
            if status=='error':
                state['status']='error';statepath.write_text(json.dumps(state,indent=2),encoding='utf-8')
                raise RuntimeError(json.dumps(record['status']))
            outputs=record.get('outputs',{}).get('save',{})
            media=[v for values in outputs.values() if isinstance(values,list) for v in values if isinstance(v,dict) and v.get('filename','').endswith('.mp4')]
            if media:
                meta=media[0]
                with urllib.request.urlopen(base+'/view?'+urllib.parse.urlencode({k:meta[k] for k in ['filename','subfolder','type'] if k in meta}),timeout=120) as r:
                    (out/(a.name+'.mp4')).write_bytes(r.read())
                state.update(status='complete',elapsed=time.time()-started,media=meta)
                statepath.write_text(json.dumps(state,indent=2),encoding='utf-8')
                print('DONE '+str(out/(a.name+'.mp4')),flush=True)
                return
            if status=='success':raise RuntimeError('No MP4 metadata: '+json.dumps(outputs))
        time.sleep(5)
    raise TimeoutError(state['prompt_id'])

if __name__=='__main__':main()
