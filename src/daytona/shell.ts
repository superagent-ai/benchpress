export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function writeFileCommand(path: string, content: string): string {
  let delimiter = 'BENCHPRESS_FILE_EOF';
  while (content.split('\n').includes(delimiter)) {
    delimiter = `${delimiter}_NEXT`;
  }
  return `cat > ${shellQuote(path)} <<'${delimiter}'\n${content}\n${delimiter}`;
}
