import {
  useState,
  useRef,
  useEffect,
  type FormEvent,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react';
import {
  Send,
  ArrowUp,
  Square,
  PanelLeftClose,
  PanelLeftOpen,
  Bot,
  AlertTriangle,
  Paperclip,
  Mic,
  MicOff,
  X,
} from 'lucide-react';
import { useWebLLM, DEFAULT_MODEL } from './hooks/useWebLLM';
import { Sidebar } from './components/Sidebar';
import { ChatContainer } from './components/ChatContainer';
import { SettingsModal } from './components/SettingsModal';
import type { MessageAttachment } from './types';

import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// Web Speech API type shims (not in TypeScript's default lib)
interface ISpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: ISpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}
interface ISpeechRecognitionEvent {
  results: { length: number; [i: number]: { [j: number]: { transcript: string } } };
}
type SpeechRecognitionCtor = new () => ISpeechRecognition;

export default function App() {
  const {
    status,
    progress,
    progressText,
    modelCached,
    conversations,
    activeConversationId,
    currentMessages,
    sendMessage,
    editMessage,
    stopGeneration,
    startNewChat,
    loadConversation,
    deleteConversation,
    regenerateResponse,
    renameConversation,
    error,
    systemPrompt,
    setSystemPrompt,
    activeModel,
  } = useWebLLM(DEFAULT_MODEL);

  const [input, setInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<MessageAttachment[]>([]);
  const [isListening, setIsListening] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const baseInputRef = useRef('');

  // Auto-resize the textarea as the user types
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input]);

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if ((!trimmed && attachedFiles.length === 0) || status !== 'ready') return;
    sendMessage(
      trimmed,
      attachedFiles.length > 0 ? attachedFiles : undefined,
    );
    setInput('');
    setAttachedFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // ── File upload ──────────────────────────────────────────────────────────
  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);

    for (const file of files) {
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
          let fullText = '';
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            fullText += textContent.items.map((item: any) => item.str).join(' ') + '\n';
          }
          setAttachedFiles(prev => [...prev, { name: file.name, content: fullText }]);
        } catch (err) {
          console.error('Error parsing PDF:', err);
          alert(`Failed to extract text from ${file.name}`);
        }
      } else {
        const reader = new FileReader();
        reader.onload = ev => {
          const content = ev.target?.result as string;
          setAttachedFiles(prev => [...prev, { name: file.name, content }]);
        };
        reader.readAsText(file);
      }
    }
    e.target.value = '';
  };

  const removeAttachment = (name: string) =>
    setAttachedFiles(prev => prev.filter(f => f.name !== name));

  // ── Speech-to-text ───────────────────────────────────────────────────────
  const handleMicClick = () => {
    const SR: SpeechRecognitionCtor | undefined =
      (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition;

    if (!SR) {
      alert('Speech recognition is not supported in this browser. Try Chrome or Edge.');
      return;
    }

    if (isListening) {
      (window as unknown as { _sr?: ISpeechRecognition })._sr?.stop();
      return;
    }

    baseInputRef.current = input;
    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    (window as unknown as { _sr?: ISpeechRecognition })._sr = recognition;

    recognition.onresult = (event: ISpeechRecognitionEvent) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      const sep = baseInputRef.current && !baseInputRef.current.endsWith(' ') ? ' ' : '';
      setInput(baseInputRef.current + sep + transcript);
    };

    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognition.start();
    setIsListening(true);
  };

  // ── Suggested starter prompts ────────────────────────────────────────────
  const SUGGESTED_PROMPTS = [
    'Explain how async/await works in JavaScript',
    'Write a Python function to reverse a string',
    'What is the difference between TCP and UDP?',
    'Summarise the key principles of clean code',
  ];

  const handleSuggestedPrompt = (prompt: string) => {
    if (status !== 'ready') return;
    sendMessage(prompt);
  };

  const isLoading = status === 'loading';
  const isGenerating = status === 'generating';
  const isError = status === 'error';
  const canSend = status === 'ready' && (
    input.trim().length > 0 || attachedFiles.length > 0
  );

  const modelLabel = activeModel.includes('E4B') ? 'Gemma 4 E4B' : 'Gemma 4 E2B';

  return (
    <>
    <div className="flex h-screen bg-[#212121] text-[#ececec] overflow-hidden font-sans">
      {/* ── Sidebar ───────────────────────────────────────────────────────── */}
      {sidebarOpen && (
        <Sidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          modelCached={modelCached}
          modelName={activeModel}
          onNewChat={startNewChat}
          onLoadConversation={loadConversation}
          onDeleteConversation={deleteConversation}
          onRenameConversation={renameConversation}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      {/* ── Main panel ────────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {/* ── Top bar ─────────────────────────────────────────────────────── */}
        <header className="flex items-center gap-2 px-4 py-3 shrink-0">
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="p-2 rounded-lg text-[#8e8ea0] hover:text-[#ececec] transition-colors"
            aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          >
            {sidebarOpen
              ? <PanelLeftClose size={20} />
              : <PanelLeftOpen size={20} />
            }
          </button>

          <span className="text-sm font-medium text-[#adadbe] ml-2">{modelLabel}</span>

          {/* Progress pill — initial load */}
          {isLoading && (
            <div className="ml-auto flex items-center gap-2 text-xs text-[#8e8ea0]">
              <div className="w-24 h-1.5 bg-[#2a2a2a] rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span>{progress}%</span>
            </div>
          )}
        </header>

        {/* ── Loading screen ───────────────────────────────────────────────── */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center flex-1 gap-8 px-6">
            <div className="text-center space-y-3">
              <div className="w-14 h-14 rounded-full bg-white flex items-center justify-center mx-auto animate-pulse">
                <Bot size={24} className="text-[#212121]" />
              </div>
              <h2 className="text-xl font-semibold">Loading {modelLabel}</h2>
              <p className="text-sm text-[#8e8ea0] max-w-xs mx-auto">
                Running 100% locally in your browser via WebGPU.
                <br />No data is ever sent to a server.
              </p>
            </div>

            {/* Progress bar */}
            <div className="w-full max-w-md space-y-2">
              <div className="flex justify-between items-center text-xs text-[#6e6e80]">
                <span className="truncate max-w-[80%]">{progressText}</span>
                <span className="shrink-0 ml-3 tabular-nums">{progress}%</span>
              </div>
              <div className="h-2 bg-[#2a2a2a] rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            <p className="text-xs text-[#6e6e80] text-center max-w-sm">
              {progress < 100
                ? 'Model weights are being downloaded and cached in your browser\'s IndexedDB. Subsequent loads will be instant.'
                : 'Compiling WebGPU shaders… almost there!'}
            </p>
          </div>
        )}

        {/* ── Error screen ─────────────────────────────────────────────────── */}
        {isError && (
          <div className="flex flex-col items-center justify-center flex-1 gap-4 px-6 text-center">
            <AlertTriangle size={36} className="text-red-400" />
            <div className="space-y-1">
              <p className="font-medium text-red-400">Engine Error</p>
              <p className="text-sm text-[#8e8ea0] max-w-md">{error}</p>
            </div>
            <p className="text-xs text-[#6e6e80] max-w-sm">
              Make sure your browser supports WebGPU and that the COOP/COEP
              headers are set (see <code className="text-emerald-300">vite.config.ts</code>).
            </p>
          </div>
        )}

        {/* ── Chat area ────────────────────────────────────────────────────── */}
        {!isLoading && !isError && (
          <>
            {/* Empty state */}
            {currentMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center flex-1 gap-6
                              text-center px-6">
                <div className="w-16 h-16 rounded-full bg-white
                                flex items-center justify-center">
                  <Bot size={32} className="text-[#212121]" />
                </div>
                <h1 className="text-2xl font-semibold tracking-tight text-[#ececec]">
                  What can I help with?
                </h1>

                {/* Suggested prompts */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4 max-w-2xl w-full">
                  {SUGGESTED_PROMPTS.map(p => (
                    <button
                      key={p}
                      onClick={() => handleSuggestedPrompt(p)}
                      disabled={status !== 'ready'}
                      className="text-left text-sm text-[#ececec] border border-[#444]
                                 rounded-xl px-5 py-3 hover:bg-[#2f2f2f]
                                 transition-colors duration-200 disabled:opacity-40
                                 disabled:cursor-not-allowed"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <ChatContainer
                messages={currentMessages}
                isGenerating={isGenerating}
                onRegenerate={regenerateResponse}
                onEditMessage={editMessage}
              />
            )}

            {/* ── Input area ─────────────────────────────────────────────── */}
            <div className="shrink-0 px-4 pb-5 pt-2">
              <form
                onSubmit={handleSubmit}
                className="max-w-3xl mx-auto"
              >
                <div
                  className="relative flex flex-col bg-[#2f2f2f] rounded-3xl
                             ring-1 ring-[#3a3a3a] focus-within:ring-[#555]
                             transition-shadow duration-150"
                >
                  {/* Attached file chips */}
                  {attachedFiles.length > 0 && (
                    <div className="flex flex-wrap gap-2 px-4 pt-3">
                      {attachedFiles.map(f => (
                        <span
                          key={f.name}
                          className="flex items-center gap-1.5 bg-[#1a1a1a] text-[#adadbe]
                                     text-xs px-2.5 py-1 rounded-lg border border-[#3a3a3a]"
                        >
                          <Paperclip size={11} className="shrink-0" />
                          <span className="max-w-[120px] truncate">{f.name}</span>
                          <button
                            type="button"
                            onClick={() => removeAttachment(f.name)}
                            className="ml-0.5 text-[#6e6e80] hover:text-red-400 transition-colors"
                            aria-label={`Remove ${f.name}`}
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-end gap-2 px-4 py-3">
                    {/* Hidden file input */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept=".txt,.md,.pdf,.markdown,.json,.csv,.js,.ts,.jsx,.tsx,.py,.html,.css,.xml,.yaml,.yml,.toml,.sh,.bash,.c,.cpp,.h,.java,.go,.rs,.rb,.php,.sql"
                      onChange={handleFileChange}
                      className="hidden"
                    />

                    {/* Attach button */}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isLoading || isError}
                      className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-[#ececec] bg-transparent
                                 hover:bg-[#3a3a3a] transition-colors disabled:opacity-30
                                 disabled:cursor-not-allowed mb-0.5 mr-2"
                      aria-label="Attach file"
                    >
                      <Paperclip size={18} />
                    </button>

                    <textarea
                      ref={textareaRef}
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Message Gemma 4…"
                      rows={1}
                      disabled={isLoading || isError}
                      className="flex-1 bg-transparent text-[15px] pt-1.5 text-[#ececec] placeholder-[#8e8ea0]
                                 resize-none outline-none leading-relaxed
                                 min-h-[24px] max-h-[200px] overflow-y-auto mb-0.5"
                    />

                    {/* Mic button */}
                    <button
                      type="button"
                      onClick={handleMicClick}
                      disabled={isLoading || isError || isGenerating}
                      className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition-colors mr-1 mb-0.5
                                  disabled:opacity-30 disabled:cursor-not-allowed
                                  ${
                                    isListening
                                      ? 'text-red-400 bg-red-400/10 animate-pulse'
                                      : 'text-[#ececec] hover:bg-[#3a3a3a]'
                                  }`}
                      aria-label={isListening ? 'Stop listening' : 'Start voice input'}
                    >
                      {isListening ? <MicOff size={18} /> : <Mic size={18} />}
                    </button>

                    {isGenerating ? (
                      /* Stop button */
                      <button
                        type="button"
                        onClick={stopGeneration}
                        className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-[#ececec] text-black
                                   hover:bg-white transition-colors mb-0.5"
                        aria-label="Stop generation"
                      >
                        <Square size={13} fill="currentColor" />
                      </button>
                    ) : (
                      /* Send button */
                      <button
                        type="submit"
                        disabled={!canSend}
                        className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-[#ececec] text-black
                                   disabled:bg-[#3a3a3a] disabled:text-[#8e8ea0]
                                   disabled:opacity-50 disabled:cursor-not-allowed
                                   hover:bg-white transition-colors mb-0.5"
                        aria-label="Send message"
                      >
                        <ArrowUp size={16} strokeWidth={3} />
                      </button>
                    )}
                  </div>
                </div>

                <p className="mt-3 text-center text-xs text-[#8e8ea0]">
                  Gemma 4 runs locally in your browser. No data leaves your device.
                </p>
              </form>
            </div>
          </>
        )}
      </div>
    </div>

    <SettingsModal
      open={settingsOpen}
      systemPrompt={systemPrompt}
      onSave={setSystemPrompt}
      onClose={() => setSettingsOpen(false)}
    />
    </>
  );
}
