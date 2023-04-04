import { timeStamp } from "console";

type Timestamp = number;
type Tick = number;

interface TickData {
  timestamp: Timestamp;
  tick: Tick;
}
export const cticks: TickData[] = [

  {timestamp: 1680542092491, tick: 42953},
  {timestamp: 1680542092491, tick: 42954},
  {timestamp: 1680542092492, tick: 42955},
  {timestamp: 1680542092492, tick: 42958},
  {timestamp: 1680542092492, tick: 42962},
  {timestamp: 1680542128504, tick: 42969}
];

export const mticks: TickData[] = [

  {timestamp: 1666542092491, tick: 42950},
  {timestamp: 1680542092491, tick: 42953},
  {timestamp: 1680542092491, tick: 42954},
  {timestamp: 1680542092492, tick: 42955},
  {timestamp: 1680542092492, tick: 42958},
  {timestamp: 1680542092492, tick: 42962},
  {timestamp: 1680542128504, tick: 42969}
];

// add dbgnow  as export
export const dbgnow: Timestamp = 1680542128504

