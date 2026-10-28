import React, { useRef, useEffect } from 'react';
import { User, Volume2, Loader2 } from 'lucide-react';
import { TranscriptItem } from '../lib/types';

interface TranscriptLiveProps {
  transcript: TranscriptItem[];
  meHasVoiceActivity?: boolean;
  themHasVoiceActivity?: boolean;
}

export const TranscriptLive: React.FC<TranscriptLiveProps> = ({
  transcript,
  meHasVoiceActivity,
  themHasVoiceActivity,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Live Voice Activity Strip */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-950/60 border-b border-slate-800 text-[11px] text-slate-400">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              meHasVoiceActivity ? 'bg-emerald-400 animate-ping' : 'bg-slate-600'
            }`}
          />
          <span className={meHasVoiceActivity ? 'text-emerald-400 font-semibold' : ''}>
            You (Mic)
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              themHasVoiceActivity ? 'bg-purple-400 animate-ping' : 'bg-slate-600'
            }`}
          />
          <span className={themHasVoiceActivity ? 'text-purple-400 font-semibold' : ''}>
            Remote (System Audio)
          </span>
        </div>
      </div>

      {/* Transcript Scroll Area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 space-y-2.5 text-xs select-text"
      >
        {transcript.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-1 text-center py-8">
            <Volume2 className="w-6 h-6 text-slate-600" />
            <p>No audio transcribed yet.</p>
            <p className="text-[10px] text-slate-600">
              Start listening from the pill to transcribe live conversation.
            </p>
          </div>
        ) : (
          transcript.map(item => {
            const isMe = item.role === 'me';
            return (
              <div
                key={item.id}
                className={`flex flex-col p-2 rounded-lg border transition-all ${
                  isMe
                    ? 'bg-slate-800/40 border-slate-700/50'
                    : 'bg-indigo-950/20 border-indigo-900/40'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1 text-[10px] font-semibold">
                    <User className={`w-3 h-3 ${isMe ? 'text-emerald-400' : 'text-purple-400'}`} />
                    <span className={isMe ? 'text-emerald-300' : 'text-purple-300'}>
                      {isMe ? 'You' : 'Remote Speaker'}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono">
                    {new Date(item.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                </div>
                <div className="text-slate-200 leading-relaxed">
                  {item.status === 'transcribing' ? (
                    <span className="flex items-center gap-1 text-slate-400 italic">
                      <Loader2 className="w-3 h-3 animate-spin" /> Transcribing speech segment...
                    </span>
                  ) : (
                    item.text
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

