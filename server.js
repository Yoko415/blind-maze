const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// 迷路サイズ設定（奇数である必要があります。棒倒し法のアルゴリズム上の制約）
const MAZE_WIDTH = 11;
const MAZE_HEIGHT = 11;
const GOAL_X = MAZE_WIDTH - 2;
const GOAL_Y = MAZE_HEIGHT - 2;

// 幅優先探索 (BFS) でスタート(0,0)からゴールへの到達可能性を判定する関数
// 棒倒し法は「唯一の道」しか生成しないため、その道の途中に爆弾が置かれると
// 爆弾を踏まない限り絶対に先へ進めなくなり、クリア不可能になってしまう。
// そのため爆弾(2)も壁(1)と同様に「踏まずに迂回すべき障害物」として扱い、
// 爆弾を一切踏まずにゴールへ到達できる経路が存在するかを判定する。
function isSolvable(maze, goalX = GOAL_X, goalY = GOAL_Y) {
    const height = maze.length;
    const width = maze[0].length;
    const queue = [{ x: 0, y: 0 }];
    const visited = Array.from({ length: height }, () => Array(width).fill(false));
    visited[0][0] = true;

    const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];

    while (queue.length > 0) {
        const { x, y } = queue.shift();

        if (x === goalX && y === goalY) return true; // ゴール到達

        for (const [dx, dy] of dirs) {
            const nx = x + dx;
            const ny = y + dy;

            // 範囲内かつ未訪問で、壁(1)でも爆弾(2)でもない場所のみ進む
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                if (!visited[ny][nx] && maze[ny][nx] !== 1 && maze[ny][nx] !== 2) {
                    visited[ny][nx] = true;
                    queue.push({ x: nx, y: ny });
                }
            }
        }
    }
    return false; // 到達不可
}

// 100%クリア可能なランダム迷路生成関数
function generateRandomMaze(width = MAZE_WIDTH, height = MAZE_HEIGHT, minBombs = 3, bombRatio = 0.15) {
    const goalX = width - 2;
    const goalY = height - 2;
    let maze;

    while (true) {
        maze = Array.from({ length: height }, () => Array(width).fill(1));

        const stack = [{ x: 1, y: 1 }];
        maze[1][1] = 0;
        const dirs = [[0, 2], [2, 0], [0, -2], [-2, 0]];

        while (stack.length > 0) {
            const current = stack[stack.length - 1];
            const nextDirs = dirs.slice().sort(() => Math.random() - 0.5);
            let moved = false;

            for (const [dx, dy] of nextDirs) {
                const nx = current.x + dx;
                const ny = current.y + dy;
                if (nx > 0 && nx < width - 1 && ny > 0 && ny < height - 1 && maze[ny][nx] === 1) {
                    maze[current.y + dy / 2][current.x + dx / 2] = 0;
                    maze[ny][nx] = 0;
                    stack.push({ x: nx, y: ny });
                    moved = true;
                    break;
                }
            }

            if (!moved) {
                stack.pop();
            }
        }

        maze[0][0] = 0;
        maze[0][1] = 0;
        maze[1][0] = 0;
        maze[goalY][goalX] = 3;
        maze[goalY - 1][goalX] = 0;
        maze[goalY][goalX - 1] = 0;

        const emptyCells = [];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (maze[y][x] === 0) {
                    if ((x <= 1 && y <= 1) || (x >= goalX - 1 && y >= goalY - 1)) continue;
                    emptyCells.push({ x, y });
                }
            }
        }

        let bombCount = Math.max(minBombs, Math.floor(emptyCells.length * bombRatio));
        bombCount = Math.min(bombCount, emptyCells.length);
        for (let i = 0; i < bombCount; i++) {
            const randIdx = Math.floor(Math.random() * emptyCells.length);
            const cell = emptyCells.splice(randIdx, 1)[0];
            maze[cell.y][cell.x] = 2;
        }

        if (isSolvable(maze, goalX, goalY)) {
            return maze;
        }
    }
}

function generateRandomMiniMaze() {
    return generateRandomMaze(5, 5, 1, 0.2);
}

const rooms = {};

// ルームのタイマー類を一括クリアする補助関数
function clearRoomTimers(room) {
    if (!room) return;
    if (room.emergencyTimer) clearTimeout(room.emergencyTimer);
    if (room.delayTimer) clearTimeout(room.delayTimer);
    if (room.prepTimer) clearInterval(room.prepTimer);
    if (room.countdownTimer) clearInterval(room.countdownTimer);
}

io.on('connection', (socket) => {
    let currentRoom = null;

    socket.on('joinRoom', ({ roomId, password, action }) => {
        if (!roomId || !password) return socket.emit('errorMsg', '部屋名とパスワードを入力してください。');

        if (action === 'create') {
            if (rooms[roomId]) {
                return socket.emit('errorMsg', 'その部屋名は既に使用されています。別の名前を指定してください。');
            }
            rooms[roomId] = {
                password,
                players: {},
                positions: {},
                restartVotes: {},
                emergency: false,
                overrideActive: false,
                overridePending: false,
                overrideStarted: false,
                activeOverridePlayers: new Set(),
                emergencyTimer: null,
                delayTimer: null,
                prepTimer: null,
                countdownTimer: null,
                miniPos: { x: 0, y: 0, dir: 'SOUTH' },
                miniMaze: generateRandomMiniMaze(),
                maze: generateRandomMaze() // 必ず解ける迷路を渡す
            };
        } else if (action === 'join') {
            if (!rooms[roomId]) {
                return socket.emit('errorMsg', '指定された部屋が存在しません。');
            }
        }

        const room = rooms[roomId];
        if (room.password !== password) return socket.emit('errorMsg', 'パスワードが違います。');

        const playerCount = Object.keys(room.players).length;
        if (playerCount >= 2 && !room.players[socket.id]) {
            return socket.emit('errorMsg', 'この部屋はすでに満員です。');
        }

        currentRoom = roomId;
        socket.join(roomId);

        let role = playerCount === 0 ? 'navigator' : 'player';
        room.players[socket.id] = role;

        if (role === 'player') {
            room.positions[socket.id] = { x: 0, y: 0, dir: 'SOUTH' };
        }

        socket.emit('joinedRoom', { roomId, role, maze: room.maze, playerCount: playerCount + 1 });

        if (playerCount + 1 === 2) {
            io.to(roomId).emit('gameReady', '2人の接続が完了しました。ゲームを開始します。');
            scheduleNextEmergency(roomId);
        }
    });

    function scheduleNextEmergency(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        if (room.emergencyTimer) clearTimeout(room.emergencyTimer);

        room.emergencyTimer = setTimeout(() => {
            if (rooms[roomId]) {
                triggerEmergency(roomId);
            }
        }, 60000);
    }

    function triggerEmergency(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        clearRoomTimers(room);

        room.emergency = true;
        room.overrideActive = false;
        room.overridePending = true;
        room.overrideStarted = false;
        room.activeOverridePlayers.clear();

        io.to(roomId).emit('emergencyTriggered', {
            message: 'SYSTEM WARNING: 操作系統反転！操作役の入力軸が逆転しました。<br>※指示役は通常通りの方向指示を出してください。<br>30秒後に解除システムが起動します。'
        });

        if (room.delayTimer) clearTimeout(room.delayTimer);
        room.delayTimer = setTimeout(() => {
            if (rooms[roomId] && room.emergency) {
                triggerOverridePhase(roomId);
            }
        }, 30000);
    }

    function triggerOverridePhase(roomId) {
        const room = rooms[roomId];
        if (!room || !room.emergency) return;

        room.overridePending = false;
        room.overrideActive = true;
        room.overrideStarted = false;
        room.activeOverridePlayers.clear();
        room.miniPos = { x: 0, y: 0, dir: 'SOUTH' };
        room.miniMaze = generateRandomMiniMaze();

        io.to(roomId).emit('startOverridePhase', {
            miniGrid: room.miniMaze,
            miniPos: room.miniPos
        });

        let prepTimeLeft = 30;
        io.to(roomId).emit('miniTimerUpdate', { mode: 'PREP', time: prepTimeLeft });

        if (room.prepTimer) clearInterval(room.prepTimer);

        room.prepTimer = setInterval(() => {
            prepTimeLeft--;
            if (room.overrideStarted) {
                clearInterval(room.prepTimer);
                return;
            }

            if (prepTimeLeft <= 0) {
                clearInterval(room.prepTimer);
                startActualOverrideTimer(roomId);
            } else {
                io.to(roomId).emit('miniTimerUpdate', { mode: 'PREP', time: prepTimeLeft });
            }
        }, 1000);
    }

    function startActualOverrideTimer(roomId) {
        const room = rooms[roomId];
        if (!room || room.overrideStarted) return;

        if (room.prepTimer) clearInterval(room.prepTimer);
        room.overrideStarted = true;

        let timeLeft = 30;
        io.to(roomId).emit('miniTimerUpdate', { mode: 'ACTIVE', time: timeLeft });

        if (room.countdownTimer) clearInterval(room.countdownTimer);

        room.countdownTimer = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('miniTimerUpdate', { mode: 'ACTIVE', time: timeLeft });

            if (timeLeft <= 0) {
                clearInterval(room.countdownTimer);
                if (room.overrideActive) {
                    endOverridePhase(roomId, false, '時間切れです！');
                }
            }
        }, 1000);
    }

    function checkAndStartOverrideTimer(roomId, socketId) {
        const room = rooms[roomId];
        if (!room || !room.overrideActive) return;

        room.activeOverridePlayers.add(socketId);

        if (!room.overrideStarted && room.activeOverridePlayers.size >= 2) {
            startActualOverrideTimer(roomId);
        }
    }

    function endOverridePhase(roomId, success, reason = '') {
        const room = rooms[roomId];
        if (!room) return;

        if (room.prepTimer) clearInterval(room.prepTimer);
        if (room.countdownTimer) clearInterval(room.countdownTimer);

        room.overridePending = false;
        room.overrideActive = false;
        room.overrideStarted = false;
        room.activeOverridePlayers.clear();

        if (success) {
            room.emergency = false;
            io.to(roomId).emit('overrideResult', { success: true });
            scheduleNextEmergency(roomId);
        } else {
            io.to(roomId).emit('overrideResult', { success: false, message: reason });
            scheduleNextEmergency(roomId);
        }
    }

    function resetGamePositions(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        for (let pid in room.positions) {
            room.positions[pid] = { x: 0, y: 0, dir: 'SOUTH' };
        }

        io.to(roomId).emit('gameReset', { message: '爆弾に接触しました！初期位置からやり直します。' });
    }

    function fullResetGame(roomId, swapRoles = false) {
        const room = rooms[roomId];
        if (!room) return;

        clearRoomTimers(room);

        room.emergency = false;
        room.overridePending = false;
        room.overrideActive = false;
        room.overrideStarted = false;
        room.activeOverridePlayers.clear();
        room.restartVotes = {};

        if (swapRoles) {
            for (let pid in room.players) {
                room.players[pid] = (room.players[pid] === 'player') ? 'navigator' : 'player';
            }
        }

        // クリア確定済みの新しい迷路を生成
        room.maze = generateRandomMaze();
        room.positions = {};

        for (let pid in room.players) {
            if (room.players[pid] === 'player') {
                room.positions[pid] = { x: 0, y: 0, dir: 'SOUTH' };
            }
        }

        for (let pid in room.players) {
            io.to(pid).emit('fullGameRestarted', {
                role: room.players[pid],
                maze: room.maze
            });
        }

        scheduleNextEmergency(roomId);
    }

    socket.on('changeDirection', (inputDir) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.players[socket.id] !== 'player') return;

        let effectiveDir = inputDir;
        if (room.emergency) {
            const invertDirMap = { NORTH: 'SOUTH', SOUTH: 'NORTH', EAST: 'WEST', WEST: 'EAST' };
            effectiveDir = invertDirMap[inputDir];
        }

        if (room.overrideActive) {
            checkAndStartOverrideTimer(currentRoom, socket.id);
            room.miniPos.dir = effectiveDir;
            io.to(currentRoom).emit('updateMiniPos', {
                miniGrid: room.miniMaze,
                miniPos: room.miniPos
            });
        } else {
            let pos = room.positions[socket.id];
            if (pos) {
                pos.dir = effectiveDir;
                io.to(currentRoom).emit('updatePosition', pos);
            }
        }
    });

    socket.on('moveRelative', (step) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.players[socket.id] !== 'player') return;

        let effectiveStep = step;
        if (room.emergency) {
            const invertMoveMap = { FORWARD: 'BACK', BACK: 'FORWARD', LEFT: 'RIGHT', RIGHT: 'LEFT' };
            effectiveStep = invertMoveMap[step];
        }

        const vectors = {
            NORTH: { FORWARD: [0, -1], BACK: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] },
            SOUTH: { FORWARD: [0, 1], BACK: [0, -1], LEFT: [1, 0], RIGHT: [-1, 0] },
            EAST:  { FORWARD: [1, 0], BACK: [-1, 0], LEFT: [0, -1], RIGHT: [0, 1] },
            WEST:  { FORWARD: [-1, 0], BACK: [1, 0], LEFT: [0, 1], RIGHT: [0, -1] }
        };

        if (room.overrideActive) {
            checkAndStartOverrideTimer(currentRoom, socket.id);
            let pos = room.miniPos;
            let moveVec = vectors[pos.dir][effectiveStep];
            let newX = pos.x + moveVec[0];
            let newY = pos.y + moveVec[1];

            if (newY >= 0 && newY < 5 && newX >= 0 && newX < 5) {
                pos.x = newX;
                pos.y = newY;

                if (room.miniMaze[newY][newX] === 2) {
                    endOverridePhase(currentRoom, false, '爆弾に接触しました！');
                } else if (room.miniMaze[newY][newX] === 3) {
                    endOverridePhase(currentRoom, true);
                } else {
                    io.to(currentRoom).emit('updateMiniPos', {
                        miniGrid: room.miniMaze,
                        miniPos: pos
                    });
                }
            }
            return;
        }

        let pos = room.positions[socket.id];
        if (!pos) return;

        let moveVec = vectors[pos.dir][effectiveStep];
        let newX = pos.x + moveVec[0];
        let newY = pos.y + moveVec[1];

        if (newY >= 0 && newY < room.maze.length && newX >= 0 && newX < room.maze[0].length) {
            if (room.maze[newY][newX] !== 1) {
                pos.x = newX;
                pos.y = newY;

                if (room.maze[newY][newX] === 2) {
                    resetGamePositions(currentRoom);
                } else if (room.maze[newY][newX] === 3) {
                    io.to(currentRoom).emit('gameCleared');
                } else {
                    io.to(currentRoom).emit('updatePosition', pos);
                }
            }
        }
    });

    socket.on('sendSignal', (signalMsg) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const role = room.players[socket.id];

        if (room.overrideActive) {
            checkAndStartOverrideTimer(currentRoom, socket.id);
        }

        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

        io.to(currentRoom).emit('receiveSignal', {
            msg: signalMsg,
            time: timeStr,
            role: role
        });
    });

    socket.on('requestRestart', (type) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];

        if (!room.restartVotes[type]) {
            room.restartVotes[type] = new Set();
        }
        room.restartVotes[type].add(socket.id);

        if (room.restartVotes[type].size >= Object.keys(room.players).length) {
            fullResetGame(currentRoom, type === 'swap');
        } else {
            socket.emit('waitRestartChoice', '相方の選択を待っています...');
        }
    });

    const handlePlayerDisconnect = () => {
        if (currentRoom && rooms[currentRoom]) {
            delete rooms[currentRoom].players[socket.id];
            delete rooms[currentRoom].positions[socket.id];
            socket.leave(currentRoom);

            if (Object.keys(rooms[currentRoom].players).length === 0) {
                clearRoomTimers(rooms[currentRoom]);
                delete rooms[currentRoom];
            } else {
                io.to(currentRoom).emit('playerLeft');
            }
            currentRoom = null;
        }
    };

    socket.on('leaveRoom', handlePlayerDisconnect);
    socket.on('disconnect', handlePlayerDisconnect);
});

module.exports = {
    generateRandomMaze,
    generateRandomMiniMaze,
    isSolvable
};

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}