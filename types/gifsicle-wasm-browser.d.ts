declare module "gifsicle-wasm-browser" {
  type GifsicleInputItem = {
    file: string | Blob | File | ArrayBuffer;
    name: string;
  };

  type GifsicleRunParams = {
    input: GifsicleInputItem[];
    command: string[];
    folder?: string[];
    isStrict?: boolean;
  };

  type GifsicleApi = {
    run(params: GifsicleRunParams): Promise<File[]>;
  };

  const gifsicle: GifsicleApi;
  export default gifsicle;
}
