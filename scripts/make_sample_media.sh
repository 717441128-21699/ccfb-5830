#!/usr/bin/env bash
# 合成多机位庭审测试素材:
#   base.wav      —— 150s "现场音频"(粉噪底 + 不规则啁啾, 供互相关对齐)
#   cam1.mp4      —— 1280x720@25, 会话 t=0.00 开机, 录 120s
#   cam2.mp4      —— 960x540@30,  会话 t=8.40 开机, 录 110s
#   cam3.mp4      —— 640x360@25,  会话 t=21.75 开机, 录 100s
#   recorder.m4a  —— 录音笔, 会话 t=-6.30 开机(提前 6.3s), 录 156.3s
# 每路视频烧入"会话时间码"(CAM x HH:MM:SS.mmm), 对齐后可直接目视核对。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=public/sample-media
mkdir -p "$OUT"
PY=scripts/gen_tc.py

CHIRPS="between(t,3.2,3.9)+between(t,11.7,12.3)+between(t,24.1,25.0)+between(t,37.6,38.2)+between(t,49.0,49.8)+between(t,63.3,64.1)+between(t,78.9,79.5)+between(t,91.2,92.0)+between(t,104.5,105.3)+between(t,118.0,118.8)+between(t,131.4,132.2)+between(t,143.8,144.5)"

echo "== base audio =="
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "anoisesrc=color=pink:amplitude=0.05:duration=150:seed=7" \
  -f lavfi -i "aevalsrc='0.5*sin(2*PI*(500+900*sin(2*PI*0.8*t))*t)*($CHIRPS)':s=48000:d=150" \
  -filter_complex "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]" \
  -map "[a]" -c:a pcm_s16le "$OUT/base.wav"

make_cam () { # name offset dur size fps color
  local name=$1 off=$2 dur=$3 size=$4 fps=$5 color=$6
  local w=${size%x*} h=${size#*x}
  local box_y=$(( h / 2 + 60 )) bx=$(( w - 220 )) by=$(( h - 180 ))
  echo "== $name (offset ${off}s) =="
  python3 "$PY" --fps "$fps" --duration "$dur" --offset "$off" --label "$(echo "$name" | tr 'a-z' 'A-Z' | sed 's/\([0-9]\)/ \1/')" \
  | ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=$color:size=$size:rate=$fps:duration=$dur" \
    -f rawvideo -pix_fmt rgba -s 700x96 -r "$fps" -i - \
    -i "$OUT/base.wav" \
    -filter_complex "\
      [0:v]drawbox=x='100+mod(t*180\,$(( w - 200 )))':y=$box_y:w=90:h=90:c=white@0.85:t=fill,\
           drawbox=x=$bx:y=$by:w=120:h=120:c=yellow@0.6:t=fill:enable='lt(mod(t\,4)\,2)',\
           drawgrid=width=iw/8:height=ih/6:thickness=1:color=white@0.12[base];\
      [base][1:v]overlay=16:16:shortest=1[v];\
      [2:a]atrim=start=$off:duration=$dur,asetpts=PTS-STARTPTS,highpass=f=60[a]" \
    -map "[v]" -map "[a]" \
    -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p \
    -c:a aac -b:a 128k -shortest "$OUT/$name.mp4"
}

make_cam cam1 0     120 1280x720 25 0x1a2b4a
make_cam cam2 8.4   110  960x540 30 0x3a2b1a
make_cam cam3 21.75 100  640x360 25 0x1a3a2b

echo "== recorder (offset -6.3s) =="
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "anullsrc=r=44100:cl=mono:d=6.3" \
  -i "$OUT/base.wav" \
  -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1,volume=1.1,atrim=duration=156.3[a]" \
  -map "[a]" -c:a aac -b:a 128k "$OUT/recorder.m4a"

rm -f "$OUT/base.wav"
echo "done. files in $OUT:"
ls -lh "$OUT"
