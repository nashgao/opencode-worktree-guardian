import fs, { type Stats } from "node:fs";
import promises from "node:fs/promises";

export type LiveFileDescriptor = {
  readonly fd: number;
  readonly stat: Stats;
};

function descriptorStat(fd: number): Promise<Stats | null> {
  return new Promise((resolve, reject) => {
    fs.fstat(fd, (error, stat) => {
      if (!error) {
        resolve(stat);
        return;
      }
      if (error.code === "EBADF" || error.code === "ENOENT") {
        resolve(null);
        return;
      }
      reject(error);
    });
  });
}

export async function liveFileDescriptors(): Promise<readonly LiveFileDescriptor[]> {
  const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  const names = await promises.readdir(descriptorDirectory);
  const observed = await Promise.all(names.filter((name) => /^\d+$/.test(name)).map(async (name) => {
    const fd = Number(name);
    return { fd, stat: await descriptorStat(fd) };
  }));
  return observed.flatMap((entry) => entry.stat ? [{ fd: entry.fd, stat: entry.stat }] : []);
}
