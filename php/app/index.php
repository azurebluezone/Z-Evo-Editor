<?php
declare(strict_types=1);

// =============================================================================
// PHP front controller
// -----------------------------------------------------------------------------
// The browser contract is the existing index.live.php page. This controller
// serves that page with runtime values injected at request time, and proxies
// the UI's API calls to the Node runtime. No project path is hardcoded here.
// =============================================================================

$appDir = __DIR__;
$snapshot = $appDir . '/index.live.php';
$nodeUrl = rtrim((string) (getenv('ZC_NODE_URL') ?: 'http://127.0.0.1:8787'), '/');
$proxyToken = (string) (getenv('ZC_PROXY_TOKEN') ?: '');
$workspace = (string) (getenv('ZC_WORKSPACE') ?: dirname(__DIR__, 2));
$requestUri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
$path = parse_url($requestUri, PHP_URL_PATH) ?: '/';
$identityName = (string) (getenv('ZC_IDENTITY_NAME') ?: 'ZombieCoder');
$identityVersion = (string) (getenv('ZC_IDENTITY_VERSION') ?: '1.0.0');
$identityOwner = (string) (getenv('ZC_IDENTITY_OWNER') ?: 'Sahon Srabon');
$poweredBy = (string) (getenv('ZC_IDENTITY_POWERED_BY') ?: 'ZombieCoder-by-SahonSrabon');
$identityWebsite = (string) (getenv('ZC_IDENTITY_WEBSITE') ?: 'https://zombiecoder.my.id/');

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header('X-Powered-By: ' . $poweredBy);
header('X-System-Identity: ' . $identityName);
header('X-System-Version: ' . $identityVersion);
header('X-System-Owner: ' . $identityOwner);
header('X-System-Website: ' . $identityWebsite);

if ($path === '/healthz') {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode([
        'ok' => true,
        'service' => 'zc-php-front',
        'node' => $nodeUrl,
        'workspace' => $workspace,
    ]);
    exit;
}

$act = (string) ($_GET['act'] ?? '');
$apiAction = (string) ($_GET['ai_php_api'] ?? '');
$isStream = isset($_GET['ai_chat_stream']) && (string) $_GET['ai_chat_stream'] === '1';

if ($act === 'ai' && ($apiAction !== '' || $isStream)) {
    proxy_to_node($nodeUrl, $proxyToken, $apiAction, $isStream);
    exit;
}

if ($path !== '/' && $path !== '/index.php' && $path !== '/index.live.php') {
    $candidate = realpath($appDir . $path);
    if ($candidate !== false && strpos($candidate, realpath($appDir) . DIRECTORY_SEPARATOR) === 0 && is_file($candidate)) {
        return false;
    }
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Not found\n";
    exit;
}

serve_frontend($snapshot, $nodeUrl, $proxyToken, $workspace);

function http_json(string $url, string $token, int $timeout = 3): ?array
{
    if (!function_exists('curl_init')) {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'header' => "Accept: application/json\r\nX-ZC-Proxy-Token: {$token}\r\n",
                'timeout' => $timeout,
            ],
        ]);
        $raw = @file_get_contents($url, false, $context);
        if ($raw === false) {
            return null;
        }
        $json = json_decode($raw, true);
        return is_array($json) ? $json : null;
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => $timeout,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_HTTPHEADER => [
            'Accept: application/json',
            'X-ZC-Proxy-Token: ' . $token,
        ],
    ]);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($raw === false || $status !== 200) {
        return null;
    }
    $json = json_decode((string) $raw, true);
    return is_array($json) ? $json : null;
}

function serve_frontend(string $snapshot, string $nodeUrl, string $token, string $workspace): void
{
    if (!is_file($snapshot)) {
        http_response_code(500);
        header('Content-Type: text/plain; charset=utf-8');
        echo "index.live.php snapshot is missing\n";
        return;
    }

    $projectId = trim((string) ($_GET['project_id'] ?? ''));
    $bootstrapUrl = $nodeUrl . '/api/bootstrap';
    if ($projectId !== '') {
        $bootstrapUrl .= '?project_id=' . rawurlencode($projectId);
    }
    $boot = http_json($bootstrapUrl, $token, 3) ?: [];
    $identity = is_array($boot['identity'] ?? null) ? $boot['identity'] : [];
    $project = is_array($boot['project'] ?? null) ? $boot['project'] : [];
    $csrf = (string) ($boot['csrf'] ?? bin2hex(random_bytes(18)));
    $projectPath = (string) ($project['path'] ?? $workspace);
    $projectIdValue = (string) ($project['id'] ?? '');

    $html = (string) file_get_contents($snapshot);
    $oldHome = '';
    if (preg_match("/HD='([^']+)'/", $html, $homeMatch)) {
        $oldHome = (string) $homeMatch[1];
    }
    $config = [
        'node_url' => $nodeUrl,
        'workspace' => $workspace,
        'project_id' => $projectIdValue,
        'project_path' => $projectPath,
        'identity' => [
            'name' => (string) ($identity['name'] ?? ''),
            'owner' => (string) ($identity['owner'] ?? ''),
            'version' => (string) ($identity['version'] ?? ''),
            'tagline' => (string) ($identity['tagline'] ?? ''),
            'powered_by_header' => (string) ($identity['powered_by_header'] ?? ''),
            'branding' => is_array($identity['branding'] ?? null) ? $identity['branding'] : [],
            'contact' => is_array($identity['contact'] ?? null) ? $identity['contact'] : [],
        ],
        'csrf' => $csrf,
        'version' => (string) ($boot['version'] ?? ''),
    ];
    $js = static fn ($value): string => (string) json_encode(
        $value,
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP
    );

    $init = "var A='index.php?act=ai',C=" . $js($csrf)
        . ",SP=" . $js($projectPath)
        . ",HD=" . $js($workspace)
        . ",PID=" . $js($projectIdValue);
    $html = (string) preg_replace(
        "/var A='index\\.live\\.php\\?act=ai',C='[^']*',SP='[^']*',HD='[^']*',PID='[^']*'/",
        $init,
        $html,
        1
    );
    if ($oldHome !== '' && $oldHome !== $workspace) {
        $html = str_replace($oldHome, $workspace, $html);
    }
    // The snapshot's tool-result handler looks for a word in the style attribute
    // instead of the status text. Add a class and target that class in the copy
    // served to the browser; the downloaded snapshot itself stays untouched.
    $html = str_replace(
        'style="color:var(--ac);font-size:10px;margin-left:auto">running...</span>',
        'class="ocTkRun" style="color:var(--ac);font-size:10px;margin-left:auto">running...</span>',
        $html
    );
    $html = str_replace(
        'found.querySelector(\'span[style*="running"]\')',
        'found.querySelector(\'.ocTkRun\')',
        $html
    );
    $bootstrapScript = '<script>window.__ZC_BOOTSTRAP__=' . $js($config) . ';</script>';
    if (strpos($html, '</head>') !== false) {
        $html = str_replace('</head>', $bootstrapScript . "\n</head>", $html);
    }

    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    header('Content-Security-Policy: frame-ancestors \'self\'');
    echo $html;
}

function proxy_to_node(string $nodeUrl, string $token, string $action, bool $isStream): void
{
    $identityName = (string) (getenv('ZC_IDENTITY_NAME') ?: 'ZombieCoder');
    $poweredBy = (string) (getenv('ZC_IDENTITY_POWERED_BY') ?: 'ZombieCoder-by-SahonSrabon');
    $target = $nodeUrl . ($isStream ? '/frontend/stream' : '/frontend/action');
    if (!$isStream) {
        $target .= '?action=' . rawurlencode($action);
        $forward = ['path', 'depth', 'conversation_id', 'project_id', 'csrf_token'];
        foreach ($forward as $key) {
            if (isset($_GET[$key])) {
                $target .= '&' . rawurlencode($key) . '=' . rawurlencode((string) $_GET[$key]);
            }
        }
    } else {
        $target .= '?project_id=' . rawurlencode((string) ($_GET['project_id'] ?? ''));
    }

    $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $rawBody = $method === 'POST' ? (string) file_get_contents('php://input') : '';
    $headers = [
        'Accept: ' . ($isStream ? 'text/event-stream' : 'application/json'),
        'X-ZC-Proxy-Token: ' . $token,
        'X-ZC-Forwarded-Host: ' . (string) ($_SERVER['HTTP_HOST'] ?? ''),
        'X-ZC-Forwarded-For: ' . (string) ($_SERVER['REMOTE_ADDR'] ?? ''),
        'X-ZC-Identity: ' . $identityName,
        'X-Powered-By: ' . $poweredBy,
    ];
    if ($method === 'POST') {
        $headers[] = 'Content-Type: application/x-www-form-urlencoded';
    }

    if (!function_exists('curl_init')) {
        proxy_without_curl($target, $method, $rawBody, $headers, $isStream);
        return;
    }

    $ch = curl_init($target);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => 600,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_BUFFERSIZE => 1024,
    ]);
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
    }

    if ($isStream) {
        while (ob_get_level() > 0) {
            @ob_end_clean();
        }
        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-cache, no-transform');
        header('X-Accel-Buffering: no');
        header('Connection: keep-alive');
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, static function ($curl, string $chunk): int {
            echo $chunk;
            if (function_exists('ob_flush')) {
                @ob_flush();
            }
            flush();
            return strlen($chunk);
        });
        $ok = curl_exec($ch);
        if ($ok === false) {
            $message = curl_error($ch);
            echo 'data: ' . json_encode([
                '_event' => 'error',
                'message' => 'PHP proxy failed: ' . $message,
            ]) . "\n\n";
        }
        curl_close($ch);
        return;
    }

    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $body = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $contentType = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $error = curl_error($ch);
    curl_close($ch);
    if ($body === false) {
        http_response_code(502);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['success' => false, 'error' => 'Node runtime unreachable: ' . $error]);
        return;
    }
    http_response_code($status > 0 ? $status : 502);
    header('Content-Type: ' . ($contentType !== '' ? $contentType : 'application/json; charset=utf-8'));
    header('Cache-Control: no-store');
    echo $body;
}

function proxy_without_curl(string $target, string $method, string $body, array $headers, bool $isStream): void
{
    if ($isStream) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['success' => false, 'error' => 'streaming proxy requires the PHP curl extension']);
        return;
    }
    $context = stream_context_create([
        'http' => [
            'method' => $method,
            'header' => implode("\r\n", $headers),
            'content' => $body,
            'timeout' => 300,
            'ignore_errors' => true,
        ],
    ]);
    $raw = @file_get_contents($target, false, $context);
    if ($raw === false) {
        http_response_code(502);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['success' => false, 'error' => 'Node runtime unreachable']);
        return;
    }
    $status = 200;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('/^HTTP\/\S+\s+(\d+)/', $line, $m)) {
            $status = (int) $m[1];
        }
    }
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo $raw;
}
