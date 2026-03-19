const Codewords = {
    // Server to Client message packages
    SERVER_TO_PLAYER_MESSAGE : 'system_to_player_message',  // ie. "Play is now on Player X"
    SERVER_TO_TABLE_MESSAGE : 'system_to_table_message',    // ie. "Player X has joined the table", "Player Y has left the table"

    // Player to Player message packages
    PLAYER_TO_PLAYER_MESSAGE : 'player_to_player_message',  // ie. "Player X has sent you a message", "Player X has sent a message to the table"
    // Server to Client Action requests
    SERVER_REQUEST_CALL : 'server_request_call',
    SERVER_REQUEST_CHECK: 'server_request_check',
    
    // Deal cards to player
    DEAL_HOLE_CARDS : 'deal_hole_cards',

    // Server to Client game state update
    SERVER_UPDATE_LAST_ACTION : 'server_update_last_action', 
    SERVER_UPDATE_STAGE_PROGRESSION : 'server_update_stage_progression',
    SERVER_UPDATE_GAME_END : 'server_update_game_end',
    SERVER_GAME_ENDED_RETURN_TO_TABLE : 'server_game_ended_return_to_table',

    GAMESTATE : 'gamestate',

    // Client to Server responses
    PLAYER_ACTION_CALL : 'player_action_call',
    PLAYER_ACTION_FOLD : 'player_action_fold',
    PLAYER_ACTION_RAISE : 'player_action_raise',
    PLAYER_ACTION_CHECK : 'player_action_check',
    PLAYER_ACTION_ALLIN : 'player_action_allin',

    // Error handling
    ERROR_MESSAGE : 'error_message',
    ACTION_RESPONSE : 'action_response',
    REQUEST_GAME_STATE : 'request_game_state',

    // Helper packages
    GAMESTATE_BET : 'gamestate_bet',
    TABLE_SEATS : 'table_seats',
}

// ═══════════════════════════════════════════════════════════════════
// Messages 
// ═══════════════════════════════════════════════════════════════════
class ServerToPlayerMessage {
    constructor ({player_id, message, timestamp = new Date()}) {
        this.type = Codewords.SERVER_TO_PLAYER_MESSAGE;
        this.player_id = player_id;
        this.message = message;
        this.timestamp = timestamp;
    }
}

class ServerToTableMessage {
    constructor ({table_id, message, timestamp = new Date()}) {
        this.type = Codewords.SERVER_TO_TABLE_MESSAGE;
        this.table_id = table_id;
        this.message = message;
        this.timestamp = timestamp;
    }
}

class PlayerToPlayerMessage {
    constructor ({from_player_id, to_player_id, message, timestamp = new Date()}) {
        this.type = Codewords.PLAYER_TO_PLAYER_MESSAGE;
        this.from_player_id = from_player_id;
        this.to_player_id = to_player_id;
        this.message = message;
        this.timestamp = timestamp;
    }
}

// ═══════════════════════════════════════════════════════════════════
// Server Requests
// ═══════════════════════════════════════════════════════════════════
class ServerRequestCheck {
    constructor ({game_id, player_id, seat, min_raise}){
        this.type = Codewords.SERVER_REQUEST_CHECK;
        this.game_id = game_id;
        this.player_id = player_id;
        this.seat = seat;
        this.min_raise = min_raise;
        this.actions = ["check", "raise", "allin"];
    }
}

class ServerRequestCall {
    constructor ({game_id, player_id, seat, min_raise, to_call}){
        this.type = Codewords.SERVER_REQUEST_CALL;
        this.game_id = game_id;
        this.player_id = player_id;
        this.seat = seat;
        this.min_raise = min_raise;
        this.to_call = to_call;
        this.actions = [`call ${to_call}`, "raise", "allin", "fold"];
    }
}

// ═══════════════════════════════════════════════════════════════════
// Player Action
// ═══════════════════════════════════════════════════════════════════
class PlayerAction {
    // if player_bet is -1, player folds.  
    constructor ({game_id, seat, current_bet, player_bet, allin}){
        this.game_id = game_id;
        this.seat = seat;
        this.current_bet = current_bet; // the table's current_bet at the time of the action
        this.player_bet = player_bet;

        if (allin){
            this.type = Codewords.PLAYER_ACTION_ALLIN;
        }
        else if (player_bet === -1){
            this.type = Codewords.PLAYER_ACTION_FOLD;
        }
        else if (current_bet === 0 && player_bet === 0){
            this.type = Codewords.PLAYER_ACTION_CHECK;
        }
        else if (current_bet > 0 && player_bet === current_bet){
            this.type = Codewords.PLAYER_ACTION_CALL;
        }
        else if (player_bet > current_bet){
            this.type = Codewords.PLAYER_ACTION_RAISE;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// GAME 
// ═══════════════════════════════════════════════════════════════════
class GameState {
    constructor ({game_id, table_id, big_blind, dealer_seat, max_players, hot_seat, stage, aggrounds, pot, current_bet, bets, community_cards, deck}){
        this.type = Codewords.GAMESTATE;
        this.game_id = game_id;
        this.table_id = table_id;
        this.big_blind = big_blind;
        this.dealer_seat = dealer_seat;
        this.max_players = max_players;
        this.hot_seat = hot_seat;
        this.stage = stage; // pre-flop, flop, turn, river
        this.aggrounds = aggrounds; // integer - number of rounds needed to progress to next stage
        this.pot = pot;
        this.current_bet = current_bet;
        this.bets = bets; // array of GameStateBet objects
        this.community_cards = community_cards; // array of card objects
        this.deck = deck; // array of card objects
    }

    difference(otherGameState){
        const differences = {};
        for (const key of Object.keys(this)){
            if (JSON.stringify(this[key]) !== JSON.stringify(otherGameState[key])){
                differences[key] = this[key];
            }
        }
        return differences;
    }
}

class GameStateBet {
    constructor ({seat, bet_amount, allin, folded}){
        this.type = Codewords.GAMESTATE_BET;
        this.seat = seat;
        this.bet_amount = bet_amount;
        this.allin = allin;
        this.folded = folded;
    }
}

class ServerUpdateLastAction {
    constructor ({game_id, seat, bet_amount, allin, folded}){
        this.type = Codewords.SERVER_UPDATE_LAST_ACTION;
        this.game_id = game_id;
        this.seat = seat;
        this.bet_amount = bet_amount;
        this.allin = allin;
        this.folded = folded;
    }
}

class ServerUpdateStageProgression {
    constructor ({game_id, stage, community_cards}){
        this.type = Codewords.SERVER_UPDATE_STAGE_PROGRESSION;
        this.game_id = game_id;
        this.stage = stage;
        this.community_cards = community_cards; // array of card objects
    }
}

class ServerUpdateGameEnd {
    constructor ({game_id, winner_seat, winning_hand, pot}){
        this.type = Codewords.SERVER_UPDATE_GAME_END;
        this.game_id = game_id;
        this.winner_seat = winner_seat;
        this.winning_hand = winning_hand;
        this.pot = pot;
    }
}

class ServerGameEndedReturnToTable {
    constructor ({table_id, winners, pot, message}){
        this.type = Codewords.SERVER_GAME_ENDED_RETURN_TO_TABLE;
        this.table_id = table_id;
        this.winners = winners; // array of winner objects with player_id, username, amount, hand
        this.pot = pot;
        this.message = message || 'Game ended - ready to start new round';
        this.timestamp = new Date();
    }
}

// ═══════════════════════════════════════════════════════════════════
// Error Handling & Communication
// ═══════════════════════════════════════════════════════════════════
class ErrorMessage {
    constructor ({message, game_id = null, player_id = null}){
        this.type = Codewords.ERROR_MESSAGE;
        this.message = message;
        this.game_id = game_id;
        this.player_id = player_id;
        this.timestamp = new Date();
    }
}

class ActionResponse {
    constructor ({success, error = null, game_id = null, player_id = null}){
        this.type = Codewords.ACTION_RESPONSE;
        this.success = success;
        this.error = error;
        this.game_id = game_id;
        this.player_id = player_id;
        this.timestamp = new Date();
    }
}

class RequestGameState {
    constructor ({game_id, player_id = null}){
        this.type = Codewords.REQUEST_GAME_STATE;
        this.game_id = game_id;
        this.player_id = player_id;
        this.timestamp = new Date();
    }
}

// ═══════════════════════════════════════════════════════════════════
// Misc
// ═══════════════════════════════════════════════════════════════════

function createFromJSON(json){
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    switch (data.type){
        case Codewords.SERVER_TO_PLAYER_MESSAGE:
            return new ServerToPlayerMessage(data);
        case Codewords.SERVER_TO_TABLE_MESSAGE:
            return new ServerToTableMessage(data);
        case Codewords.PLAYER_TO_PLAYER_MESSAGE:
            return new PlayerToPlayerMessage(data);
        case Codewords.SERVER_REQUEST_CALL:
            return new ServerRequestCall(data);
        case Codewords.SERVER_REQUEST_CHECK:
            return new ServerRequestCheck(data);
        case Codewords.GAMESTATE:
            return new GameState(data);
        case Codewords.GAMESTATE_BET:
            return new GameStateBet(data);
        case Codewords.SERVER_UPDATE_LAST_ACTION:
            return new ServerUpdateLastAction(data);
        case Codewords.SERVER_UPDATE_STAGE_PROGRESSION:
            return new ServerUpdateStageProgression(data);
        case Codewords.SERVER_UPDATE_GAME_END:
            return new ServerUpdateGameEnd(data);
        case Codewords.SERVER_GAME_ENDED_RETURN_TO_TABLE:
            return new ServerGameEndedReturnToTable(data);
        case Codewords.ERROR_MESSAGE:
            return new ErrorMessage(data);
        case Codewords.ACTION_RESPONSE:
            return new ActionResponse(data);
        case Codewords.REQUEST_GAME_STATE:
            return new RequestGameState(data);
        case Codewords.PLAYER_ACTION_CALL:
        case Codewords.PLAYER_ACTION_FOLD:
        case Codewords.PLAYER_ACTION_RAISE:
        case Codewords.PLAYER_ACTION_CHECK:
        case Codewords.PLAYER_ACTION_ALLIN:
            return new PlayerAction(data);
        default:
            throw new Error(`Unknown package type: ${data.type}`);
    }
}

module.exports = {
    PackageType: Codewords,
    ServerToPlayerMessage,
    ServerToTableMessage,
    PlayerToPlayerMessage,
    ServerRequestCheck,
    ServerRequestCall,
    PlayerAction,
    GameState,
    GameStateBet,
    ServerUpdateLastAction,
    ServerUpdateStageProgression,
    ServerUpdateGameEnd,
    ServerGameEndedReturnToTable,
    ErrorMessage,
    ActionResponse,
    RequestGameState,
    createFromJSON
}