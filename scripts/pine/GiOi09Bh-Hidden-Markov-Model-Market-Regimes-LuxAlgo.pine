// This work is licensed under a Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0) https://creativecommons.org/licenses/by-nc-sa/4.0/
// © LuxAlgo

//@version=6
indicator("Hidden Markov Model Market Regimes [LuxAlgo]", "LuxAlgo - HMM Regimes", overlay = false, max_bars_back = 1000)

//---------------------------------------------------------------------------------------------------------------------}
// Constants
//---------------------------------------------------------------------------------------------------------------------{
color GRAY              = #9598a1
color ORANGE            = #ff9800
color RED               = #f23645
color BLUE              = #00bcd4

DATA                    = #DBDBDB
HEADERS                 = #808080
BACKGROUND              = #161616
BORDERS                 = #2E2E2E

TOP_RIGHT               = 'Top Right'
BOTTOM_RIGHT            = 'Bottom Right'
BOTTOM_LEFT             = 'Bottom Left'

TINY                    = 'Tiny'
SMALL                   = 'Small'
NORMAL                  = 'Normal'
LARGE                   = 'Large'
HUGE                    = 'Huge'

//---------------------------------------------------------------------------------------------------------------------}
// Inputs
//---------------------------------------------------------------------------------------------------------------------{
string HMM_GROUP        = 'HMM Settings'
int lookbackInput       = input.int(50, 'Lookback Period', minval = 10, group = HMM_GROUP, tooltip = 'Lookback for calculating volatility and mean returns.')
float smoothingInput    = input.float(0.1, 'Learning Rate', minval = 0.01, maxval = 1.0, step = 0.05, group = HMM_GROUP, tooltip = 'Adjusts how quickly the model adapts to new data.')

string DASHBOARD_GROUP  = 'Dashboard'
bool dashboardInput     = input.bool(true, 'Enable Dashboard', group = DASHBOARD_GROUP)
string dashboardPosInput= input.string(TOP_RIGHT, 'Position', group = DASHBOARD_GROUP, options = [TOP_RIGHT, BOTTOM_RIGHT, BOTTOM_LEFT])
string dashboardSizeInput= input.string(SMALL, 'Size', group = DASHBOARD_GROUP, options = [TINY, SMALL, NORMAL, LARGE, HUGE])

//---------------------------------------------------------------------------------------------------------------------}
// Logic
//---------------------------------------------------------------------------------------------------------------------{
// Observation data: Log Returns
float logReturn         = math.log(close / close[1])
float meanReturn        = ta.sma(logReturn, lookbackInput)
float volatility        = ta.stdev(logReturn, lookbackInput)

// Normalized Observations
float normReturn        = (logReturn - meanReturn) / (volatility + 1e-9)
float normVol           = volatility / (ta.sma(volatility, lookbackInput) + 1e-9)

// State Emission Likelihoods (Heuristic-based Probabilities)
// 1. Low Volatility Trend (Steady movement, low volatility)
float emissionLowVolTrend = math.exp(-math.pow(normVol - 0.7, 2) / 0.5) * math.exp(-math.pow(normReturn - 0.5, 2) / 2.0)

// 2. High Volatility Chop (Large moves, no clear direction)
float emissionHighVolChop = math.exp(-math.pow(normVol - 1.5, 2) / 1.0) * math.exp(-math.pow(normReturn, 2) / 0.5)

// 3. Crash Regime (Sharp drop, high volatility)
float emissionCrash       = math.exp(-math.pow(normVol - 2.0, 2) / 1.0) * (normReturn < -1.5 ? 1.0 : math.exp(-math.pow(normReturn + 2.0, 2) / 1.0))

// 4. Accumulation Phase (Low volatility, flat/rounding)
float emissionAccum       = math.exp(-math.pow(normVol - 0.6, 2) / 0.5) * math.exp(-math.pow(normReturn + 0.2, 2) / 1.0)

// Initial Transition Matrix (Pij: probability of moving from state i to j)
// Diagonals are higher (persistence)
var float p00 = 0.9, var float p01 = 0.05, var float p02 = 0.02, var float p03 = 0.03
var float p10 = 0.1, var float p11 = 0.80, var float p12 = 0.05, var float p13 = 0.05
var float p20 = 0.0, var float p21 = 0.10, var float p22 = 0.85, var float p23 = 0.05
var float p30 = 0.1, var float p31 = 0.05, var float p32 = 0.00, var float p33 = 0.85

// State Probabilities (Initialization)
var float prob0 = 0.25
var float prob1 = 0.25
var float prob2 = 0.25
var float prob3 = 0.25

// Forward Algorithm (Update step)
if not na(normVol)
    // Prediction step (using previous probabilities and transition matrix)
    float prior0 = prob0 * p00 + prob1 * p10 + prob2 * p20 + prob3 * p30
    float prior1 = prob0 * p01 + prob1 * p11 + prob2 * p21 + prob3 * p31
    float prior2 = prob0 * p02 + prob1 * p12 + prob2 * p22 + prob3 * p32
    float prior3 = prob0 * p03 + prob1 * p13 + prob2 * p23 + prob3 * p33
    
    // Update step (likelihood * prior)
    float unnorm0 = emissionLowVolTrend * prior0
    float unnorm1 = emissionHighVolChop * prior1
    float unnorm2 = emissionCrash * prior2
    float unnorm3 = emissionAccum * prior3
    
    // Normalization
    float sumProbs = unnorm0 + unnorm1 + unnorm2 + unnorm3
    if sumProbs > 0
        prob0 := (1.0 - smoothingInput) * prob0 + smoothingInput * (unnorm0 / sumProbs)
        prob1 := (1.0 - smoothingInput) * prob1 + smoothingInput * (unnorm1 / sumProbs)
        prob2 := (1.0 - smoothingInput) * prob2 + smoothingInput * (unnorm2 / sumProbs)
        prob3 := (1.0 - smoothingInput) * prob3 + smoothingInput * (unnorm3 / sumProbs)
        
    // Keep sum at 1.0
    float currentSum = prob0 + prob1 + prob2 + prob3
    prob0 /= currentSum
    prob1 /= currentSum
    prob2 /= currentSum
    prob3 /= currentSum

//---------------------------------------------------------------------------------------------------------------------}
// Plots
//---------------------------------------------------------------------------------------------------------------------{
plot(prob0 * 100, "Low Vol Trend %", color = GRAY,   linewidth = 2)
plot(prob1 * 100, "High Vol Chop %", color = ORANGE, linewidth = 2)
plot(prob2 * 100, "Crash Regime %",  color = RED,    linewidth = 2)
plot(prob3 * 100, "Accumulation %",  color = BLUE,   linewidth = 2)

// Horizontal Reference Lines
hline(50, "Neutral", color = color.new(HEADERS, 50), linestyle = hline.style_dashed)
hline(80, "High Confidence", color = color.new(HEADERS, 80), linestyle = hline.style_dotted)

// Background highlighting for dominant state
int dominantState = 0
float maxProb = prob0
if prob1 > maxProb
    maxProb := prob1
    dominantState := 1
if prob2 > maxProb
    maxProb := prob2
    dominantState := 2
if prob3 > maxProb
    maxProb := prob3
    dominantState := 3

color bgColor = switch dominantState
    0 => color.new(GRAY, 90)
    1 => color.new(ORANGE, 90)
    2 => color.new(RED, 90)
    3 => color.new(BLUE, 90)
    => na

bgcolor(bgColor, title = "Dominant Regime")

//---------------------------------------------------------------------------------------------------------------------}
// Dashboard
//---------------------------------------------------------------------------------------------------------------------{
var parsedDashboardPosition = switch dashboardPosInput
    TOP_RIGHT       => position.top_right
    BOTTOM_RIGHT    => position.bottom_right
    BOTTOM_LEFT     => position.bottom_left

var parsedDashboardSize     = switch dashboardSizeInput
    TINY            => size.tiny
    SMALL           => size.small
    NORMAL          => size.normal
    LARGE           => size.large
    HUGE            => size.huge

cell(table t, int col, int row, string txt, color c = #FFFFFF, string align = text.align_right, color bg = na, float h = 0) => 
    t.cell(col, row, txt, text_color = c, text_size = parsedDashboardSize, text_halign = align, bgcolor = bg, height = h)

divider(table t, int row, int lastCol) =>    
    t.merge_cells(0, row, lastCol, row)
    cell(t, 0, row, '━━━━━━━━━━━━━━━━━━━━', align = text.align_center, h = 0.5, c = BORDERS)

if dashboardInput and barstate.islast
    var table t = table.new(parsedDashboardPosition, 2, 9, bgcolor = BACKGROUND, border_width = 0, frame_color = BORDERS, frame_width = 1)
    
    t.merge_cells(0, 0, 1, 0)
    cell(t, 0, 0, 'HMM REGIMES', c = DATA, align = text.align_center)
    
    divider(t, 1, 1)
    
    cell(t, 0, 2, 'Low Vol Trend', c = HEADERS, align = text.align_left)
    cell(t, 1, 2, str.tostring(prob0 * 100, "0.0") + "%", c = GRAY)
    
    cell(t, 0, 3, 'High Vol Chop', c = HEADERS, align = text.align_left)
    cell(t, 1, 3, str.tostring(prob1 * 100, "0.0") + "%", c = ORANGE)
    
    cell(t, 0, 4, 'Crash Regime', c = HEADERS, align = text.align_left)
    cell(t, 1, 4, str.tostring(prob2 * 100, "0.0") + "%", c = RED)
    
    cell(t, 0, 5, 'Accumulation', c = HEADERS, align = text.align_left)
    cell(t, 1, 5, str.tostring(prob3 * 100, "0.0") + "%", c = BLUE)
    
    divider(t, 6, 1)
    
    string currentRegime = switch dominantState
        0 => "Low Vol Trend"
        1 => "High Vol Chop"
        2 => "Crash Regime"
        3 => "Accumulation"
    
    color regimeColor = switch dominantState
        0 => GRAY
        1 => ORANGE
        2 => RED
        3 => BLUE
        
    cell(t, 0, 7, 'Current State', c = HEADERS, align = text.align_left)
    cell(t, 1, 7, currentRegime, c = regimeColor)
    
    cell(t, 0, 8, 'Confidence', c = HEADERS, align = text.align_left)
    cell(t, 1, 8, str.tostring(maxProb * 100, "0.0") + "%", c = DATA)

//---------------------------------------------------------------------------------------------------------------------}
