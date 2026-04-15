declare module "transit-immutable-js" {
  const transit: {
    fromJSON(json: string): { toJS(): Record<string, unknown> };
    toJSON(obj: unknown): string;
  };
  export default transit;
}
