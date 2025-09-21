<?php
// register.php — entry point for the Pub Quiz registration system

// ======== CONFIG ========
$DB_HOST = getenv('PGHOST') ?: 'localhost';
$DB_PORT = getenv('PGPORT') ?: '5432';
$DB_NAME = getenv('PGDATABASE') ?: 'quiz';
$DB_USER = getenv('PGUSER') ?: 'quiz_admin';
$DB_PASS = getenv('PGPASSWORD') ?: '';

function pg(): ?PDO
{
    static $pdo = null; global $DB_HOST,$DB_PORT,$DB_NAME,$DB_USER,$DB_PASS;
    if ($pdo === null) {
        $dsn = "pgsql:host={$DB_HOST};port={$DB_PORT};dbname={$DB_NAME};";
        $pdo = new PDO($dsn, $DB_USER, $DB_PASS, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    }
    return $pdo;
}

function respond_json($data,$code=200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data,JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT);
}

#[NoReturn] function respond_forbidden(): void
{
    http_response_code(403);
    echo "Error 403";
    exit;
}

function get_param($k, $default=null)
{
    return $_GET[$k] ?? $_POST[$k] ?? $default;
}

function verify_people(): ?array
{
    $people_id = get_param('people_id');
    /*if (!$people_id || !preg_match('/^[A-Za-z0-9]{8}$/', $people_id)) {
        return null;
    }*/

    try {
        $stmt = pg()->prepare('SELECT people_id, name, login, team_id, preference FROM people WHERE people_id = :people_id');
        $stmt->execute([':people_id' => $people_id]);
        $person = $stmt->fetch();
        if (!$person) {
            return null;
        }
        return $person;
    } catch (Throwable $e) {
        return null;
    }
}

function html_base(): void
{
    // Serve register.html (static) so JS/CSS can load separately
    $htmlPath = __DIR__ . '/register.html';
    if (!is_file($htmlPath)) {
        http_response_code(500);
        echo 'register.html is missing';
        exit;
    }
    header('Content-Type: text/html; charset=utf-8');
    readfile($htmlPath);
}

// ======== REGISTRATION FUNCTIONS ========

function get_team_status(): array
{
    try {
        $stmt = pg()->prepare('SELECT status FROM teams_status LIMIT 1');
        $stmt->execute();
        $status = $stmt->fetch();
        return [
            'status' => $status['status'] ?? 0,
            'ok' => true
        ];
    } catch (Throwable $e) {
        return [
            'ok' => false,
            'error' => 'Database error',
            'ex' => $e->getMessage()
        ];
    }
}

function set_team_status($status): array
{
    try {
        $stmt = pg()->prepare('UPDATE teams_status SET status = :status');
        $stmt->execute([':status' => $status]);
        return [
            'ok' => true,
            'status' => $status
        ];
    } catch (Throwable $e) {
        return [
            'ok' => false,
            'error' => 'Database error',
            'ex' => $e->getMessage()
        ];
    }
}

function register_interest($person_id): array
{
    try {
        $stmt = pg()->prepare('UPDATE people SET preference = \'R\' WHERE people_id = :person_id RETURNING people_id, name, preference');
        $stmt->execute([':person_id' => $person_id]);
        $result = $stmt->fetch();
        return [
            'ok' => !empty($result),
            'person' => $result
        ];
    } catch (Throwable $e) {
        return [
            'ok' => false,
            'error' => 'Database error',
            'ex' => $e->getMessage()
        ];
    }
}

function set_preference($person_id, $preference): array
{
    try {
        $stmt = pg()->prepare('UPDATE people SET preference = :preference WHERE people_id = :person_id RETURNING people_id, name, preference');
        $stmt->execute([':person_id' => $person_id, ':preference' => $preference]);
        $result = $stmt->fetch();
        return [
            'ok' => !empty($result),
            'person' => $result
        ];
    } catch (Throwable $e) {
        return [
            'ok' => false,
            'error' => 'Database error',
            'ex' => $e->getMessage()
        ];
    }
}

function join_team($person_id, $target_person_id): array
{
    try {
        pg()->beginTransaction();
        
        // Get target person's team
        $stmt = pg()->prepare('SELECT team_id FROM people WHERE people_id = :target_person_id');
        $stmt->execute([':target_person_id' => $target_person_id]);
        $target_team = $stmt->fetch();
        
        if (!$target_team || !$target_team['team_id']) {
            pg()->rollBack();
            return ['ok' => false, 'error' => 'Target person not found or not in a team'];
        }
        
        // Check team size
        $stmt = pg()->prepare('SELECT COUNT(*) as size FROM people WHERE team_id = :team_id');
        $stmt->execute([':team_id' => $target_team['team_id']]);
        $team_size = $stmt->fetch();
        
        if ($team_size['size'] >= 5) {
            pg()->rollBack();
            return ['ok' => false, 'error' => 'Team is full (max 5 members)'];
        }
        
        // Join the team
        $stmt = pg()->prepare('UPDATE people SET team_id = :team_id WHERE people_id = :person_id RETURNING people_id, name, team_id');
        $stmt->execute([':person_id' => $person_id, ':team_id' => $target_team['team_id']]);
        $result = $stmt->fetch();
        
        pg()->commit();
        return [
            'ok' => !empty($result),
            'person' => $result
        ];
    } catch (Throwable $e) {
        if (pg()->inTransaction()) {
            pg()->rollBack();
        }
        return [
            'ok' => false,
            'error' => 'Database error',
            'ex' => $e->getMessage()
        ];
    }
}

function create_team($person_id): array
{
    try {
        pg()->beginTransaction();
        
        // Create new team
        $stmt = pg()->prepare('INSERT INTO teams (team_id, name, locked, is_admin, cooldown_end, cooldown_length) VALUES (substr(md5(random()::text), 1, 8), \'Team \' || substr(md5(random()::text), 1, 4), false, false, now(), 30) RETURNING team_id');
        $stmt->execute();
        $new_team = $stmt->fetch();
        
        if (!$new_team) {
            pg()->rollBack();
            return ['ok' => false, 'error' => 'Failed to create team'];
        }
        
        // Assign person to team
        $stmt = pg()->prepare('UPDATE people SET team_id = :team_id WHERE people_id = :person_id RETURNING people_id, name, team_id');
        $stmt->execute([':person_id' => $person_id, ':team_id' => $new_team['team_id']]);
        $result = $stmt->fetch();
        
        pg()->commit();
        return [
            'ok' => !empty($result),
            'person' => $result
        ];
    } catch (Throwable $e) {
        if (pg()->inTransaction()) {
            pg()->rollBack();
        }
        return [
            'ok' => false,
            'error' => 'Database error',
            'ex' => $e->getMessage()
        ];
    }
}

function leave_team($person_id): array
{
    try {
        $stmt = pg()->prepare('UPDATE people SET team_id = NULL WHERE people_id = :person_id RETURNING people_id, name, team_id');
        $stmt->execute([':person_id' => $person_id]);
        $result = $stmt->fetch();
        return [
            'ok' => !empty($result),
            'person' => $result
        ];
    } catch (Throwable $e) {
        return [
            'ok' => false,
            'error' => 'Database error',
            'ex' => $e->getMessage()
        ];
    }
}

function get_team_members($person_id): array
{
    try {
        $stmt = pg()->prepare('SELECT p.people_id, p.name, p.login, t.team_id, t.name as team_name FROM people p LEFT JOIN teams t ON p.team_id = t.team_id WHERE p.people_id = :person_id');
        $stmt->execute([':person_id' => $person_id]);
        $result = $stmt->fetch();
        return [
            'ok' => !empty($result),
            'person' => $result
        ];
    } catch (Throwable $e) {
        return [
            'ok' => false,
            'error' => 'Database error',
            'ex' => $e->getMessage()
        ];
    }
}

function get_team_members_list($person_id): array
{
    try {
        // First get the person's team
        $stmt = pg()->prepare('SELECT team_id FROM people WHERE people_id = :person_id');
        $stmt->execute([':person_id' => $person_id]);
        $person = $stmt->fetch();
        
        if (!$person || !$person['team_id']) {
            return [
                'ok' => true,
                'members' => []
            ];
        }
        
        // Get all team members
        $stmt = pg()->prepare('SELECT p.people_id, p.name, p.login, t.team_id, t.name as team_name FROM people p LEFT JOIN teams t ON p.team_id = t.team_id WHERE p.team_id = :team_id ORDER BY p.name');
        $stmt->execute([':team_id' => $person['team_id']]);
        $members = $stmt->fetchAll();
        
        return [
            'ok' => true,
            'members' => $members
        ];
    } catch (Throwable $e) {
        return [
            'ok' => false,
            'error' => 'Database error',
            'ex' => $e->getMessage()
        ];
    }
}

function get_team_symbol($team_id): array
{
    try {
        $stmt = pg()->prepare('SELECT symbol FROM teams WHERE team_id = :team_id');
        $stmt->execute([':team_id' => $team_id]);
        $result = $stmt->fetch();
        
        if (!$result || !$result['symbol']) {
            return [
                'ok' => false,
                'error' => 'Team symbol not found'
            ];
        }
        
        $symbol = $result['symbol'];
        $svgPath = __DIR__ . '/flags/' . $symbol . '.svg';
        
        if (!file_exists($svgPath)) {
            return [
                'ok' => false,
                'error' => 'SVG file not found'
            ];
        }
        
        $svgContent = file_get_contents($svgPath);
        return [
            'ok' => true,
            'symbol' => $symbol,
            'svg' => base64_encode($svgContent)
        ];
    } catch (Throwable $e) {
        return [
            'ok' => false,
            'error' => 'Database error',
            'ex' => $e->getMessage()
        ];
    }
}

function find_person($person_id, $search): array
{
    try {
        $stmt = pg()->prepare('SELECT people_id, name, login, team_id FROM people WHERE (name ILIKE :search OR login ILIKE :search) AND people_id != :person_id LIMIT 10');
        $stmt->execute([':person_id' => $person_id, ':search' => '%' . $search . '%']);
        $results = $stmt->fetchAll();
        return [
            'ok' => true,
            'people' => $results
        ];
    } catch (Throwable $e) {
        return [
            'ok' => false,
            'error' => 'Database error',
            'ex' => $e->getMessage()
        ];
    }
}

// ======== BOOTSTRAP ========
$personRow = verify_people();
if(!$personRow) {
    respond_forbidden();
}
$cmd = strtolower((string)get_param('cmd', ''));
$json = null;

switch ($cmd) {
    case 'team_status':
        $json = get_team_status();
        break;
    case 'register_interest':
        if($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond_forbidden();
        }
        $json = register_interest($personRow['people_id']);
        break;
    case 'set_preference':
        if($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond_forbidden();
        }
        $preference = get_param('preference');
        if(!$preference) {
            respond_forbidden();
        }
        $json = set_preference($personRow['people_id'], $preference);
        break;
    case 'join_team':
        if($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond_forbidden();
        }
        $target_person_id = get_param('target_person_id');
        if(!$target_person_id) {
            respond_forbidden();
        }
        $json = join_team($personRow['people_id'], $target_person_id);
        break;
    case 'create_team':
        if($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond_forbidden();
        }
        $json = create_team($personRow['people_id']);
        break;
    case 'leave_team':
        if($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond_forbidden();
        }
        $json = leave_team($personRow['people_id']);
        break;
    case 'get_team_members':
        $json = get_team_members($personRow['people_id']);
        break;
    case 'find_person':
        $search = get_param('search');
        if(!$search) {
            respond_forbidden();
        }
        $json = find_person($personRow['people_id'], $search);
        break;
    case 'set_team_status':
        if($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond_forbidden();
        }
        $status = get_param('status');
        if($status === null) {
            respond_forbidden();
        }
        $json = set_team_status($status);
        break;
    case 'get_team_members_list':
        $json = get_team_members_list($personRow['people_id']);
        break;
    case 'get_team_symbol':
        $team_id = get_param('team_id');
        if(!$team_id) {
            respond_forbidden();
        }
        $json = get_team_symbol($team_id);
        break;
    default:
        html_base();
        exit();
}

respond_json($json);
