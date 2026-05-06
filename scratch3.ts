/**
 * useWebLLM.ts
 *
 * Custom hook that:
 *  – Detects device RAM and selects the optimal Gemma 4 model
 *  – Spawns the WebLLM Web Worker (engine.worker.ts)
 *  – Tracks model load progress (0 → 100 %)
 *  – Manages multi-conversation state persisted to localStorage
 *  – Streams AI responses word-by-word via onmessage events
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type {
  Message,
  MessageAttachment,
  Conversation,
  ToWorker,
  FromWorker,
  WorkerChatMessage,
  ContentPart,
} from '../types';
import { VISION_MODELS, selectGemma4Model } from '../types';

// ── Public surface ────────────────────────────────────────────────────────────

export type EngineStatus =
  | 'loading'     // initial model download / compile
  | 'ready'       // idle, waiting for user input
  | 'generating'  // streaming a response
  | 'error';      // unrecoverable failure

export interface UseWebLLMReturn {
  status: EngineStatus;
  /** Download/compile progress 0-100 */
  progress: number;
  progressText: string;
  /** True once model weights are fully stored in IndexedDB */
  modelCached: boolean;
  /** True when the active model supports image inputs */
  isVisionModel: boolean;
  conversations: Conversation[];
  activeConversationId: string | null;
  currentMessages: Message[];
  sendMessage: (text: string, attachments?: MessageAttachment[]) => void;
  editMessage: (id: string, newText: string) => void;
  stopGeneration: () => void;
  startNewChat: () => void;
  loadConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  regenerateResponse: () => void;
  renameConversation: (id: string, title: string) => void;
  error: string | null;
  systemPrompt: string;
  setSystemPrompt: (prompt: string) => void;
  /** The model ID currently loaded in the worker */
  activeModel: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_MODEL = selectGemma4Model();

const LS_KEY = 'webllm_conversations';
const LS_PROMPT_KEY = 'webllm_system_prompt';

const DEFAULT_SYSTEM_PROMPT = `You are a helpful, accurate, and concise AI assistant. Answer the user's questions directly and honestly.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function readConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Conversation[]) : [];
  } catch {
    return [];
  }
}

function writeConversations(convs: Conversation[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(convs));
}

function titleFromContent(content: string): string {
  const words = content.trim().replace(/\s+/g, ' ').split(' ');
  const title = words.slice(0, 6).join(' ');
  return words.length > 6 ? title + '…' : title;
}

/** Build the full text sent to the LLM, combining user text with file attachments. */
function buildLLMContent(msg: Message): string | ContentPart[] {
  if (!msg.attachments?.length) return msg.content;
  const files = msg.attachments
    .map(a => `[Attached file: ${a.name}]\n\`\`\`\n${a.content.slice(0, 8000)}\n\`\`\``)
    .join('\n\n');
  return msg.content ? `${msg.content}\n\n${files}` : files;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useWebLLM(model: string = DEFAULT_MODEL): UseWebLLMReturn {
  // ─ Worker ─
  const workerRef = useRef<Worker | null>(null);

  // ─ Engine state ─
  const [status, setStatus] = useState<EngineStatus>('loading');
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('Initialising Gemma 4…');
  const [modelCached, setModelCached] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─ Conversation state ─
  const [conversations, setConversations] = useState<Conversation[]>(readConversations);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [currentMessages, setCurrentMessages] = useState<Message[]>([]);

  // ─ System prompt ─
  const [systemPrompt, setSystemPromptState] = useState<string>(
    () => localStorage.getItem(LS_PROMPT_KEY) ?? DEFAULT_SYSTEM_PROMPT,
  );
  const systemPromptRef = useRef(systemPrompt);
  useEffect(() => { systemPromptRef.current = systemPrompt; }, [systemPrompt]);

  const setSystemPrompt = useCallback((prompt: string) => {
    const p = prompt.trim() || DEFAULT_SYSTEM_PROMPT;
    localStorage.setItem(LS_PROMPT_KEY, p);
    setSystemPromptState(p);
  }, []);

  const [activeModel] = useState<string>(model);

  // ─ Refs to avoid stale closures inside the worker message handler ─
  const pendingIdRef = useRef<string | null>(null);
  const currentMessagesRef = useRef<Message[]>([]);
  const activeConvIdRef = useRef<string | null>(null);

  // Keep refs in sync with state
  useEffect(() => { currentMessagesRef.current = currentMessages; }, [currentMessages]);
  useEffect(() => { activeConvIdRef.current = activeConversationId; }, [activeConversationId]);

  // Persist conversations to localStorage on every change
  useEffect(() => { writeConversations(conversations); }, [conversations]);

  // ─ Worker initialisation ─────────────────────────────────────────────────
  useEffect(() => {
    const worker = new Worker(
      new URL('../engine.worker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;

      switch (msg.type) {
        case 'progress': {
          setProgress(msg.progress);
          setProgressText(msg.text);
          break;
        }

        case 'ready': {
          setProgress(100);
          setProgressText('Model ready');
          setModelCached(true);
          setStatus('ready');
          break;
        }

        case 'chunk': {
          if (msg.id !== pendingIdRef.current) break;
          setCurrentMessages(prev => {
            const updated = [...prev];
            const idx = updated.findIndex(m => m.id === msg.id);
            if (idx !== -1) {
              updated[idx] = { ...updated[idx], content: updated[idx].content + msg.delta };
            }
            return updated;
          });
          break;
        }

        case 'done': {
          setStatus('ready');
          pendingIdRef.current = null;

          const convId = activeConvIdRef.current;
          const messages = currentMessagesRef.current;

          setConversations(prev => {
            const existing = prev.find(c => c.id === convId);
            if (existing) {
              return prev.map(c =>
                c.id === convId ? { ...c, messages, updatedAt: Date.now() } : c,
              );
            } else if (convId) {
              const firstUserContent = messages.find(m => m.role === 'user')?.content ?? 'New Chat';
              const fresh: Conversation = {
                id: convId,
                title: titleFromContent(firstUserContent),
                messages,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
              return [fresh, ...prev];
            }
            return prev;
          });
          break;
        }

        case 'error': {
          setError(msg.message);
          setStatus('error');
          break;
        }
      }
    };

    worker.onerror = (err) => {
      setError(err.message ?? 'Unknown worker error');
      setStatus('error');
    };

    const initMsg: ToWorker = { type: 'init', model };
    worker.postMessage(initMsg);

    return () => {
      worker.terminate();
    };
  }, [model]);

  // ─ Public API ─────────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    (text: string, attachments?: MessageAttachment[]) => {
      if (status !== 'ready' || !workerRef.current) return;

      const trimmed = text.trim();
      if (!trimmed && !attachments?.length) return;

      let convId = activeConvIdRef.current;
      if (!convId) {
        convId = uuidv4();
        activeConvIdRef.current = convId;
        setActiveConversationId(convId);
      }

      const userMsg: Message = {
        id: uuidv4(),
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
        attachments: attachments?.length ? attachments : undefined,
      };

      const assistantId = uuidv4();
      const assistantMsg: Message = {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      };

      const nextMessages = [...currentMessagesRef.current, userMsg, assistantMsg];
      setCurrentMessages(nextMessages);
      pendingIdRef.current = assistantId;

      const history: WorkerChatMessage[] = nextMessages
        .filter(m => m.id !== assistantId)
        .map(m => ({ role: m.role as 'user' | 'assistant', content: buildLLMContent(m) }));

      const generateMsg: ToWorker = {
        type: 'generate',
        id: assistantId,
        messages: [{ role: 'system', content: systemPromptRef.current }, ...history],
      };

      setStatus('generating');
      workerRef.current.postMessage(generateMsg);
    },
    [status],
  );

  const editMessage = useCallback((id: string, newText: string) => {
    if (status !== 'ready' || !workerRef.current) return;
    const trimmed = newText.trim();
    if (!trimmed) return;

    const messages = currentMessagesRef.current;
    const idx = messages.findIndex(m => m.id === id);
    if (idx === -1) return;

    const updatedUserMsg = { ...messages[idx], content: trimmed };

    const assistantId = uuidv4();
    const assistantMsg: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    const nextMessages = [...messages.slice(0, idx), updatedUserMsg, assistantMsg];
    setCurrentMessages(nextMessages);
    pendingIdRef.current = assistantId;

    const history: WorkerChatMessage[] = nextMessages
      .filter(m => m.id !== assistantId)
      .map(m => ({ role: m.role as 'user' | 'assistant', content: buildLLMContent(m) }));

    const generateMsg: ToWorker = {
      type: 'generate',
      id: assistantId,
      messages: [{ role: 'system', content: systemPromptRef.current }, ...history],
    };

    setStatus('generating');
    workerRef.current.postMessage(generateMsg);
  }, [status]);

  const stopGeneration = useCallback(() => {
    workerRef.current?.postMessage({ type: 'abort' } satisfies ToWorker);
    setStatus('ready');
    pendingIdRef.current = null;
  }, []);

  const startNewChat = useCallback(() => {
    activeConvIdRef.current = null;
    setActiveConversationId(null);
    setCurrentMessages([]);
    pendingIdRef.current = null;
  }, []);

  const loadConversation = useCallback(
    (id: string) => {
      const conv = conversations.find(c => c.id === id);
      if (!conv) return;
      activeConvIdRef.current = id;
      setActiveConversationId(id);
      setCurrentMessages(conv.messages);
    },
    [conversations],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations(prev => prev.filter(c => c.id !== id));
      if (activeConvIdRef.current === id) {
        activeConvIdRef.current = null;
        setActiveConversationId(null);
        setCurrentMessages([]);
      }
    },
    [],
  );

  const renameConversation = useCallback((id: string, title: string) => {
    setConversations(prev =>
      prev.map(c => c.id === id ? { ...c, title: title.trim() || c.title } : c),
    );
  }, []);

  const regenerateResponse = useCallback(() => {
    if (status !== 'ready' || !workerRef.current) return;

    const messages = currentMessagesRef.current;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;

    const assistantId = uuidv4();
    const assistantMsg: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    const nextMessages = [...messages.slice(0, lastUserIdx + 1), assistantMsg];
    setCurrentMessages(nextMessages);
    pendingIdRef.current = assistantId;
    setStatus('generating');

    const history: WorkerChatMessage[] = nextMessages
      .filter(m => m.id !== assistantId)
      .map(m => ({ role: m.role as 'user' | 'assistant', content: buildLLMContent(m) }));

    workerRef.current.postMessage({
      type: 'generate',
      id: assistantId,
      messages: [{ role: 'system', content: systemPromptRef.current }, ...history],
    } satisfies ToWorker);
  }, [status]);

  return {
    status,
    progress,
    progressText,
    modelCached,
    isVisionModel: VISION_MODELS.includes(activeModel),
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
  };
}
