import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import * as Network from 'expo-network';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const STORAGE_KEY = 'pocket-pilot-config-v2';
const DEFAULT_PORT = '4521';
const DEFAULT_FONT_SIZE = 15;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 24;
const MAX_TERMINAL_CHARS = 40000;
const QUICK_COMMANDS = ['codex', 'opencode', 'git status', 'npm test', 'cls'];
const TERMINAL_KEYS = [
  { label: 'Tab', payload: '\t' },
  { label: 'Esc', payload: '\u001b' },
  { label: 'Up', payload: '\u001b[A' },
  { label: 'Down', payload: '\u001b[B' },
  { label: 'Left', payload: '\u001b[D' },
  { label: 'Right', payload: '\u001b[C' },
];

type BridgeMessage =
  | { type: 'banner'; message: string; tokenHint?: string; shell?: string }
  | { type: 'output'; data: string }
  | {
      type: 'status';
      connectedClients: number;
      shell: string;
      cwd: string;
      cols: number;
      rows: number;
      pid?: number;
    }
  | { type: 'history'; data: string }
  | { type: 'cleared' }
  | { type: 'error'; message: string };

type ConnectionConfig = {
  host: string;
  port: string;
  token: string;
};

type PairingPayload = {
  type?: string;
  version?: number;
  app?: string;
  host?: string;
  hosts?: string[];
  port?: number;
  token?: string;
  name?: string;
  shell?: string;
};

type DiscoveredBridge = {
  host: string;
  port: string;
  token: string;
  name: string;
  shell: string;
};

const defaultConfig: ConnectionConfig = {
  host: '',
  port: DEFAULT_PORT,
  token: '',
};

function clampFontSize(fontSize: number) {
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize));
}

function trimTerminal(buffer: string) {
  if (buffer.length <= MAX_TERMINAL_CHARS) {
    return buffer;
  }

  return buffer.slice(buffer.length - MAX_TERMINAL_CHARS);
}

function parsePairingString(value: string): ConnectionConfig | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as PairingPayload;
    const host = typeof parsed.host === 'string' ? parsed.host : parsed.hosts?.[0];
    const port = typeof parsed.port === 'number' ? String(parsed.port) : DEFAULT_PORT;
    const token = typeof parsed.token === 'string' ? parsed.token : '';

    if (host && token) {
      return { host, port, token };
    }
  } catch {
    // Continue to URL parsing.
  }

  try {
    const url = new URL(trimmed);
    const host = url.searchParams.get('host')?.trim() ?? '';
    const port = url.searchParams.get('port')?.trim() || DEFAULT_PORT;
    const token = url.searchParams.get('token')?.trim() ?? '';

    if (host && token) {
      return { host, port, token };
    }
  } catch {
    return null;
  }

  return null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out')), ms);

    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

export default function App() {
  const [config, setConfig] = useState<ConnectionConfig>(defaultConfig);
  const [commandDraft, setCommandDraft] = useState('');
  const [terminalText, setTerminalText] = useState(
    'PocketPilot is ready.\nDiscover your PC or scan the bridge QR to connect.\n',
  );
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [isConnected, setIsConnected] = useState(false);
  const [statusText, setStatusText] = useState('Disconnected');
  const [shellName, setShellName] = useState('Waiting for bridge');
  const [currentPath, setCurrentPath] = useState('No active session');
  const [connectedClients, setConnectedClients] = useState(0);
  const [isHydrated, setIsHydrated] = useState(false);
  const [discoveredBridges, setDiscoveredBridges] = useState<DiscoveredBridge[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryMessage, setDiscoveryMessage] = useState('No discovery run yet.');
  const [isScannerVisible, setIsScannerVisible] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const socketRef = useRef<WebSocket | null>(null);
  const outputScrollRef = useRef<ScrollView | null>(null);
  const scanningLockRef = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as Partial<ConnectionConfig>;
          setConfig({
            host: typeof parsed.host === 'string' ? parsed.host : '',
            port: typeof parsed.port === 'string' ? parsed.port : DEFAULT_PORT,
            token: typeof parsed.token === 'string' ? parsed.token : '',
          });
        }
      } finally {
        setIsHydrated(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }, [config, isHydrated]);

  useEffect(() => {
    outputScrollRef.current?.scrollToEnd({ animated: true });
  }, [terminalText]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
    };
  }, []);

  const appendTerminal = (chunk: string) => {
    setTerminalText((current) => trimTerminal(current + chunk));
  };

  const sendMessage = (payload: object) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendTerminal('\n[bridge] Not connected.\n');
      return;
    }

    socket.send(JSON.stringify(payload));
  };

  const applyConfig = (nextConfig: ConnectionConfig) => {
    setConfig(nextConfig);
    appendTerminal(`\n[pairing] Loaded bridge ${nextConfig.host}:${nextConfig.port}\n`);
  };

  const connect = (overrideConfig?: ConnectionConfig) => {
    const nextConfig = overrideConfig ?? config;
    const host = nextConfig.host.trim();
    const port = nextConfig.port.trim() || DEFAULT_PORT;
    const token = nextConfig.token.trim();

    if (!host || !token) {
      appendTerminal('\n[bridge] Host and token are required.\n');
      return;
    }

    socketRef.current?.close();
    setStatusText('Connecting...');

    const url = `ws://${host}:${port}/terminal?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.onopen = () => {
      setIsConnected(true);
      setStatusText('Connected');
      void Haptics.selectionAsync();
      appendTerminal(`\n[bridge] Connected to ${host}:${port}\n`);
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as BridgeMessage;

        switch (message.type) {
          case 'banner':
            setShellName(message.shell ?? 'Connected shell');
            appendTerminal(`\n${message.message}\n`);
            break;
          case 'output':
            appendTerminal(message.data);
            break;
          case 'history':
            setTerminalText(trimTerminal(message.data));
            break;
          case 'status':
            setShellName(message.shell);
            setCurrentPath(message.cwd);
            setConnectedClients(message.connectedClients);
            setStatusText(`Live on ${message.shell}`);
            break;
          case 'cleared':
            setTerminalText('');
            break;
          case 'error':
            appendTerminal(`\n[bridge] ${message.message}\n`);
            break;
        }
      } catch {
        appendTerminal(`\n${String(event.data)}\n`);
      }
    };

    socket.onerror = () => {
      setStatusText('Connection error');
      appendTerminal('\n[bridge] Connection error.\n');
    };

    socket.onclose = () => {
      setIsConnected(false);
      setConnectedClients(0);
      setStatusText('Disconnected');
      appendTerminal('\n[bridge] Disconnected.\n');
    };
  };

  const disconnect = () => {
    socketRef.current?.close();
    socketRef.current = null;
    setIsConnected(false);
    setStatusText('Disconnected');
  };

  const runCommand = async (command?: string) => {
    const nextCommand = (command ?? commandDraft).trim();
    if (!nextCommand) {
      return;
    }

    sendMessage({ type: 'run', command: nextCommand });
    setCommandDraft('');
    void Haptics.selectionAsync();
  };

  const sendRawInput = (data: string) => {
    sendMessage({ type: 'input', data });
    void Haptics.selectionAsync();
  };

  const pasteClipboard = async () => {
    const content = await Clipboard.getStringAsync();
    if (content) {
      setCommandDraft((current) => current + content);
    }
  };

  const copyTerminal = async () => {
    await Clipboard.setStringAsync(terminalText);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const pastePairingFromClipboard = async () => {
    const content = await Clipboard.getStringAsync();
    const parsed = parsePairingString(content);

    if (!parsed) {
      appendTerminal('\n[pairing] Clipboard does not contain a valid PocketPilot pairing code.\n');
      return;
    }

    applyConfig(parsed);
  };

  const updateConfig = (key: keyof ConnectionConfig, value: string) => {
    setConfig((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const discoverBridgeAtHost = async (host: string): Promise<DiscoveredBridge | null> => {
    try {
      const response = await withTimeout(fetch(`http://${host}:${DEFAULT_PORT}/pairing`), 350);
      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as PairingPayload;
      const token = typeof payload.token === 'string' ? payload.token : '';
      const payloadHost =
        (typeof payload.host === 'string' && payload.host) ||
        (Array.isArray(payload.hosts) ? payload.hosts.find(Boolean) : '') ||
        host;

      if (!token || !payloadHost) {
        return null;
      }

      return {
        host: payloadHost,
        port: payload.port ? String(payload.port) : DEFAULT_PORT,
        token,
        name: payload.name || payloadHost,
        shell: payload.shell || 'shell',
      };
    } catch {
      return null;
    }
  };

  const discoverBridgesOnLan = async () => {
    setIsDiscovering(true);
    setDiscoveryMessage('Scanning your local network...');
    setDiscoveredBridges([]);

    try {
      const localIp = await Network.getIpAddressAsync();
      if (!localIp || !localIp.includes('.')) {
        setDiscoveryMessage('Could not determine a local IPv4 address on this device.');
        return;
      }

      const segments = localIp.split('.');
      if (segments.length !== 4) {
        setDiscoveryMessage('Local IP was not in IPv4 format.');
        return;
      }

      const prefix = `${segments[0]}.${segments[1]}.${segments[2]}`;
      const candidates: string[] = [];

      for (let index = 1; index <= 254; index += 1) {
        const host = `${prefix}.${index}`;
        if (host !== localIp) {
          candidates.push(host);
        }
      }

      const results: DiscoveredBridge[] = [];
      const concurrency = 24;

      for (let cursor = 0; cursor < candidates.length; cursor += concurrency) {
        const slice = candidates.slice(cursor, cursor + concurrency);
        const found = await Promise.all(slice.map((host) => discoverBridgeAtHost(host)));

        for (const bridge of found) {
          if (bridge && !results.some((item) => item.host === bridge.host && item.port === bridge.port)) {
            results.push(bridge);
          }
        }
      }

      if (results.length === 0) {
        setDiscoveryMessage(`No PocketPilot bridges found on ${prefix}.x`);
        return;
      }

      setDiscoveredBridges(results);
      setDiscoveryMessage(`Found ${results.length} PocketPilot bridge${results.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setDiscoveryMessage(
        `Discovery failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      setIsDiscovering(false);
    }
  };

  const openScanner = async () => {
    const permission = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    if (!permission.granted) {
      appendTerminal('\n[pairing] Camera permission is required to scan the QR code.\n');
      return;
    }

    scanningLockRef.current = false;
    setIsScannerVisible(true);
  };

  const handleQrScan = ({ data }: { data: string }) => {
    if (scanningLockRef.current) {
      return;
    }

    scanningLockRef.current = true;
    const parsed = parsePairingString(data);

    if (!parsed) {
      appendTerminal('\n[pairing] QR code did not contain a valid pairing code.\n');
      setIsScannerVisible(false);
      return;
    }

    applyConfig(parsed);
    setIsScannerVisible(false);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <LinearGradient colors={['#08131e', '#0f2436', '#17354d']} style={styles.flex}>
          <ScrollView
            contentContainerStyle={styles.pageContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.heroCard}>
              <Text style={styles.eyebrow}>POCKETPILOT</Text>
              <Text style={styles.heroTitle}>Your PC coding agent, now on Android.</Text>
              <Text style={styles.heroCopy}>
                Discover your PC on the local network, scan the pairing QR, and keep the
                terminal readable and touch-friendly on a phone.
              </Text>
            </View>

            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <Text style={styles.panelTitle}>Fast Pair</Text>
                <StatusPill isConnected={isConnected} text={statusText} />
              </View>

              <View style={styles.actionRow}>
                <ActionButton
                  label={isDiscovering ? 'Scanning...' : 'Discover PCs'}
                  onPress={() => void discoverBridgesOnLan()}
                  tone="primary"
                  disabled={isDiscovering}
                />
                <ActionButton label="Scan QR" onPress={() => void openScanner()} tone="secondary" />
              </View>

              <View style={styles.actionRow}>
                <ActionButton
                  label="Paste Pair Code"
                  onPress={() => void pastePairingFromClipboard()}
                  tone="secondary"
                />
                <ActionButton label="Connect Now" onPress={() => connect()} tone="secondary" />
              </View>

              <Text style={styles.discoveryNote}>{discoveryMessage}</Text>

              {isDiscovering ? <ActivityIndicator color="#7dd3fc" /> : null}

              {discoveredBridges.length > 0 ? (
                <View style={styles.discoveryList}>
                  {discoveredBridges.map((bridge) => (
                    <Pressable
                      key={`${bridge.host}:${bridge.port}`}
                      onPress={() =>
                        applyConfig({
                          host: bridge.host,
                          port: bridge.port,
                          token: bridge.token,
                        })
                      }
                      style={styles.discoveryCard}
                    >
                      <View style={styles.discoveryMeta}>
                        <Text style={styles.discoveryName}>{bridge.name}</Text>
                        <Text style={styles.discoveryHost}>
                          {bridge.host}:{bridge.port}
                        </Text>
                      </View>
                      <Text style={styles.discoveryShell}>{bridge.shell}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>

            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <Text style={styles.panelTitle}>Bridge Pairing</Text>
                <Text style={styles.panelMeta}>Manual fallback</Text>
              </View>

              <Text style={styles.fieldLabel}>PC Host</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={(value) => updateConfig('host', value)}
                placeholder="192.168.1.24"
                placeholderTextColor="#7091ac"
                style={styles.input}
                value={config.host}
              />

              <View style={styles.row}>
                <View style={styles.rowField}>
                  <Text style={styles.fieldLabel}>Port</Text>
                  <TextInput
                    keyboardType="number-pad"
                    onChangeText={(value) => updateConfig('port', value)}
                    placeholder={DEFAULT_PORT}
                    placeholderTextColor="#7091ac"
                    style={styles.input}
                    value={config.port}
                  />
                </View>

                <View style={styles.rowField}>
                  <Text style={styles.fieldLabel}>Token</Text>
                  <TextInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={(value) => updateConfig('token', value)}
                    placeholder="paste bridge token"
                    placeholderTextColor="#7091ac"
                    style={styles.input}
                    value={config.token}
                  />
                </View>
              </View>

              <View style={styles.actionRow}>
                <ActionButton label="Connect" onPress={() => connect()} tone="primary" />
                <ActionButton label="Disconnect" onPress={disconnect} tone="secondary" />
              </View>
            </View>

            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <View>
                  <Text style={styles.panelTitle}>Live Terminal</Text>
                  <Text style={styles.panelMeta}>{shellName}</Text>
                  <Text style={styles.panelMeta}>{currentPath}</Text>
                </View>

                <View style={styles.fontControls}>
                  <MiniButton
                    label="A-"
                    onPress={() => setFontSize((current) => clampFontSize(current - 1))}
                  />
                  <Text style={styles.fontLabel}>{fontSize}px</Text>
                  <MiniButton
                    label="A+"
                    onPress={() => setFontSize((current) => clampFontSize(current + 1))}
                  />
                </View>
              </View>

              <View style={styles.terminalToolbar}>
                <Text style={styles.toolbarText}>{connectedClients} mobile client(s)</Text>
                <Pressable onPress={copyTerminal} style={styles.toolbarButton}>
                  <Text style={styles.toolbarButtonLabel}>Copy Output</Text>
                </Pressable>
              </View>

              <ScrollView
                ref={outputScrollRef}
                style={styles.terminalFrame}
                contentContainerStyle={styles.terminalContent}
              >
                <Text
                  selectable
                  style={[
                    styles.terminalText,
                    { fontSize, lineHeight: Math.round(fontSize * 1.5) },
                  ]}
                >
                  {terminalText || ' '}
                </Text>
              </ScrollView>
            </View>

            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <Text style={styles.panelTitle}>Quick Launch</Text>
                <Text style={styles.panelMeta}>One tap for common agent commands</Text>
              </View>

              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.chipRow}>
                  {QUICK_COMMANDS.map((command) => (
                    <Pressable
                      key={command}
                      onPress={() => void runCommand(command)}
                      style={styles.commandChip}
                    >
                      <Text style={styles.commandChipText}>{command}</Text>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            </View>

            <View style={styles.panel}>
              <View style={styles.panelHeader}>
                <Text style={styles.panelTitle}>Command Pad</Text>
                <Text style={styles.panelMeta}>Touch-first input for mobile terminals</Text>
              </View>

              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                onChangeText={setCommandDraft}
                placeholder="Type a command, prompt, or shell input"
                placeholderTextColor="#7091ac"
                style={[styles.input, styles.composerInput]}
                value={commandDraft}
              />

              <View style={styles.actionRow}>
                <ActionButton
                  label="Send Command"
                  onPress={() => void runCommand()}
                  tone="primary"
                />
                <ActionButton label="Paste" onPress={() => void pasteClipboard()} tone="secondary" />
              </View>

              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.chipRow}>
                  {TERMINAL_KEYS.map((key) => (
                    <Pressable
                      key={key.label}
                      onPress={() => sendRawInput(key.payload)}
                      style={styles.keyChip}
                    >
                      <Text style={styles.keyChipText}>{key.label}</Text>
                    </Pressable>
                  ))}
                  <Pressable onPress={() => sendRawInput('\r')} style={styles.keyChip}>
                    <Text style={styles.keyChipText}>Enter</Text>
                  </Pressable>
                  <Pressable onPress={() => sendRawInput('\u0003')} style={styles.keyChip}>
                    <Text style={styles.keyChipText}>Ctrl+C</Text>
                  </Pressable>
                  <Pressable onPress={() => sendMessage({ type: 'clear' })} style={styles.keyChip}>
                    <Text style={styles.keyChipText}>Clear</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => sendMessage({ type: 'restart-shell' })}
                    style={styles.keyChip}
                  >
                    <Text style={styles.keyChipText}>Restart Shell</Text>
                  </Pressable>
                </View>
              </ScrollView>
            </View>
          </ScrollView>
        </LinearGradient>
      </KeyboardAvoidingView>

      <Modal animationType="slide" transparent visible={isScannerVisible}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.panelHeader}>
              <View>
                <Text style={styles.panelTitle}>Scan Pairing QR</Text>
                <Text style={styles.panelMeta}>Point your phone at the QR shown in the PC bridge</Text>
              </View>
              <Pressable onPress={() => setIsScannerVisible(false)} style={styles.toolbarButton}>
                <Text style={styles.toolbarButtonLabel}>Close</Text>
              </Pressable>
            </View>

            <CameraView
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleQrScan}
              style={styles.cameraView}
            />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function ActionButton({
  label,
  onPress,
  tone,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  tone: 'primary' | 'secondary';
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.actionButton,
        tone === 'primary' ? styles.primaryButton : styles.secondaryButton,
        disabled ? styles.disabledButton : null,
      ]}
    >
      <Text
        style={[
          styles.actionButtonLabel,
          tone === 'primary' ? styles.primaryButtonLabel : styles.secondaryButtonLabel,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function MiniButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.miniButton}>
      <Text style={styles.miniButtonLabel}>{label}</Text>
    </Pressable>
  );
}

function StatusPill({ isConnected, text }: { isConnected: boolean; text: string }) {
  return (
    <View style={[styles.statusPill, isConnected ? styles.statusLive : styles.statusIdle]}>
      <Text style={styles.statusPillText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#08131e',
  },
  flex: {
    flex: 1,
  },
  pageContent: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 28,
    gap: 16,
  },
  heroCard: {
    borderRadius: 28,
    padding: 22,
    backgroundColor: 'rgba(245, 250, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  eyebrow: {
    color: '#7dd3fc',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 10,
  },
  heroTitle: {
    color: '#f8fafc',
    fontSize: 30,
    fontWeight: '800',
    lineHeight: 36,
  },
  heroCopy: {
    color: '#bfd5e8',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
  },
  panel: {
    borderRadius: 24,
    padding: 18,
    backgroundColor: 'rgba(7, 16, 25, 0.82)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.18)',
    gap: 12,
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  panelTitle: {
    color: '#f8fafc',
    fontSize: 20,
    fontWeight: '700',
  },
  panelMeta: {
    color: '#88a4bd',
    fontSize: 12,
    marginTop: 2,
  },
  fieldLabel: {
    color: '#d8e4ef',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  input: {
    borderRadius: 16,
    backgroundColor: '#0f2232',
    borderWidth: 1,
    borderColor: '#23455e',
    color: '#f8fafc',
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  rowField: {
    flex: 1,
    gap: 8,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionButton: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButton: {
    backgroundColor: '#f59e0b',
  },
  secondaryButton: {
    backgroundColor: '#122c42',
    borderWidth: 1,
    borderColor: '#2a4b64',
  },
  disabledButton: {
    opacity: 0.55,
  },
  actionButtonLabel: {
    fontSize: 15,
    fontWeight: '800',
  },
  primaryButtonLabel: {
    color: '#101418',
  },
  secondaryButtonLabel: {
    color: '#d7e7f4',
  },
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusIdle: {
    backgroundColor: '#243444',
  },
  statusLive: {
    backgroundColor: '#14532d',
  },
  statusPillText: {
    color: '#eff6ff',
    fontSize: 12,
    fontWeight: '700',
  },
  discoveryNote: {
    color: '#a6c2d9',
    fontSize: 13,
    lineHeight: 18,
  },
  discoveryList: {
    gap: 10,
  },
  discoveryCard: {
    borderRadius: 16,
    padding: 14,
    backgroundColor: '#0f2232',
    borderWidth: 1,
    borderColor: '#23455e',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  discoveryMeta: {
    flex: 1,
  },
  discoveryName: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
  },
  discoveryHost: {
    color: '#8fb1cb',
    fontSize: 12,
    marginTop: 3,
  },
  discoveryShell: {
    color: '#7dd3fc',
    fontSize: 12,
    fontWeight: '700',
  },
  fontControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  miniButton: {
    borderRadius: 12,
    backgroundColor: '#0f2232',
    borderWidth: 1,
    borderColor: '#284861',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  miniButtonLabel: {
    color: '#d5e5f3',
    fontSize: 12,
    fontWeight: '700',
  },
  fontLabel: {
    color: '#9fc1dc',
    fontSize: 12,
    minWidth: 38,
    textAlign: 'center',
  },
  terminalToolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  toolbarText: {
    color: '#88a4bd',
    fontSize: 12,
  },
  toolbarButton: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#102637',
  },
  toolbarButtonLabel: {
    color: '#d8e6f2',
    fontSize: 12,
    fontWeight: '700',
  },
  terminalFrame: {
    maxHeight: 360,
    minHeight: 260,
    borderRadius: 20,
    backgroundColor: '#02070d',
    borderWidth: 1,
    borderColor: '#1f3547',
  },
  terminalContent: {
    padding: 16,
  },
  terminalText: {
    color: '#d4ffe8',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  chipRow: {
    flexDirection: 'row',
    gap: 10,
  },
  commandChip: {
    borderRadius: 999,
    backgroundColor: '#0b3142',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  commandChipText: {
    color: '#d8f7ff',
    fontSize: 13,
    fontWeight: '700',
  },
  composerInput: {
    minHeight: 110,
    textAlignVertical: 'top',
  },
  keyChip: {
    borderRadius: 14,
    backgroundColor: '#142c3d',
    borderWidth: 1,
    borderColor: '#315068',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  keyChipText: {
    color: '#e2edf6',
    fontSize: 13,
    fontWeight: '700',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 7, 13, 0.92)',
    justifyContent: 'center',
    padding: 18,
  },
  modalCard: {
    borderRadius: 24,
    padding: 18,
    backgroundColor: '#08131e',
    borderWidth: 1,
    borderColor: '#284861',
    gap: 12,
  },
  cameraView: {
    height: 340,
    borderRadius: 20,
    overflow: 'hidden',
  },
});
