use serde::{de::DeserializeOwned, Serialize};
use std::{fs, io::Read, path::Path};

pub const MAX_WORKSPACE_BYTES: usize = 512 * 1024;

pub fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "{} 不可读：{error}；请修复文件权限后重试",
                path.display()
            ))
        }
    };
    let mut bytes = Vec::new();
    file.take((MAX_WORKSPACE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_WORKSPACE_BYTES {
        return Err(format!(
            "{} 超过 512 KiB；请在应用关闭后手动缩减配置，再重新打开。原文件保留",
            path.display()
        ));
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        format!(
            "{} 配置损坏：{error}；请在应用关闭后修复 JSON，再重新打开。原文件保留",
            path.display()
        )
    })
}

pub fn write<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_WORKSPACE_BYTES {
        return Err("工作区配置超过 512 KiB，请缩短说明或减少条目后重试".into());
    }
    let parent = path.parent().ok_or("配置目录不存在")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temp, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
