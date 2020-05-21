// Type definitions for it-pipe 1.1
// Project: https://github.com/alanshaw/it-pipe#readme
// Definitions by: Irakli Gozalishvili <https://github.com/me>
// Definitions: https://github.com/DefinitelyTyped/DefinitelyTyped



type Source<T> =
  | Iterable<T>
  | AsyncIterable<T>

interface Transform <I, O> {
  (source:AsyncIterable<I>):AsyncIterable<O>
}

interface Sink <I, O> {
  (input:AsyncIterable<I>):O
}

declare interface Pipe {
  <I, O>(source:Source<I>, sink:Sink<I, O>):O
  <I, T1, O>(source:Source<I>, t1:Transform<I, T1>, sink:Sink<T1, O>):O
  <I, T1, T2, O>(source:Source<I>, t1:Transform<I, T1>, t2:Transform<T1, T2>, sink:Sink<T2, O>):O
  <I, T1, T2, T3, O>(source:Source<I>, t1:Transform<I, T1>, t2:Transform<T1, T2>, t3:Transform<T2, T3>, sink:Sink<T3, O>):O
  <I, T1, T2, T3, T4, O>(source:Source<I>, t1:Transform<I, T1>, t2:Transform<T1, T2>, t3:Transform<T2, T3>, t4:Transform<T3, T4>, sink:Sink<T4, O>):O
}

declare var pipe:Pipe;

// declare namespace pipe {
//     // Circular reference from it_pipe
//   const pipe: Pipe;
//   function isDuplex(obj: any): void;
//   function isIterable <T>(obj: any): obj is Source<T>;
//   function rawPipe(fns: any): any;
// }

export = pipe;